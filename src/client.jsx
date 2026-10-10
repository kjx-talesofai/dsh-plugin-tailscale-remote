/**
 * dsh-plugin-tailscale-remote — browser half.
 *
 * Two slot contributions, mirroring the first-party `ui-schedule` shape:
 *   `sidebar.panellist` — the nav row (icon + status dot); `order: 5` seats it
 *   between Plugins (0) and Schedules (10);
 *   `main`             — the panel body, keyed by the same id. This is the only
 *   legal home for a real `Switch`: the nav row is wrapped in the sidebar's own
 *   `<button onClick={selectPanel}>`, so a nested switch would be invalid markup
 *   and the row's click would win.
 *
 * Data rides two exact routes the host registers under `/api` — the same
 * authenticated, fenced surface the rest of the UI uses. Nothing is persisted
 * client-side, and the launch link never leaves the authenticated channel.
 *
 * @module dsh-plugin-tailscale-remote/client
 */
import * as React from 'react'
import qrcode from 'qrcode-generator'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, zh, en, fallbackT } from './locales.js'

/** Tolerate any missing export: a half-versioned host must not blank the sidebar. */
const Button = primitives.Button ?? ((props) => React.createElement('button', props))
const Switch = primitives.Switch ?? ((props) => React.createElement('button', props))
const StateDot = primitives.StateDot ?? (() => null)
const LinkIconRegular = primitives.LinkIconRegular ?? (() => null)
/** Platform clipboard helper when the host exports it (C3); local fallback otherwise. */
const writeClipboard = typeof primitives.writeClipboard === 'function' ? primitives.writeClipboard : null

/** Panel id: shared by the sidebar row and the `main` panel key. */
const PANEL_ID = 'tailscale-remote'

/** Host routes. */
const STATUS_URL = '/api/tailscale-remote.status'
const SET_URL = '/api/tailscale-remote.set'

/** Poll cadence with the panel open / closed (the sidebar dot still needs updates). */
const POLL_MS = 2500
const IDLE_POLL_MS = 15000

/** Required client services: slots for the two contributions, locale for the copy. */
export const inject = ['slots', 'locale']

/**
 * Every host failure code this build knows how to translate. Derived from the
 * shipped English dictionary, which is the terminal fallback of every language
 * chain — so a key that is present here is guaranteed to resolve, and a code
 * added by a newer host simply falls back to the host's own `detail` text.
 */
const KNOWN_DETAIL_CODES = new Set(
  Object.keys(en)
    .filter((key) => key.startsWith('detail.'))
    .map((key) => key.slice('detail.'.length)),
)

/** The framework hands `t` to a locale-declaring slot; a bare render may not have it. */
const seat = (props) => (typeof props?.t === 'function' ? props.t : fallbackT)

const muted = { opacity: 0.62 }
const row = { display: 'flex', alignItems: 'center', gap: 10 }

/** Whether the host registered its diagnostics route (learned from the status payload). */
let debugEnabled = false

/** Breadcrumb to the host (`$TMPDIR/dsh-tailscale-diag.log`) — a no-op unless the host opted in. */
const pendingDiag = []
function diag(event, detail) {
  const payload = { event, detail: detail === undefined ? '' : String(detail) }
  if (!debugEnabled) {
    // M6/D6: at cold start we do not know yet whether the host has the debug
    // route; dropping these meant the only interesting events were always lost.
    if (pendingDiag.length < 32) pendingDiag.push(payload)
    return
  }
  sendDiag(payload)
}

/** Flush what was buffered before the debug flag was known. */
function flushDiag() {
  while (pendingDiag.length > 0) sendDiag(pendingDiag.shift())
}

function sendDiag(payload) {
  try {
    void fetch('/api/tailscale-remote.diag', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
  } catch {
    /* diagnostics must never break the plugin */
  }
}

/**
 * Subscribe to the host-side status snapshot. The platform only binds injected
 * hooks that sit under a \`hooks\` key, so this plugin ships the snapshot itself and
 * reads it through \`useSyncExternalStore\` (C2/F11: the previous \`useStatus\` branch
 * was unreachable).
 */
function readStatus(snapshot) {
  return React.useSyncExternalStore(snapshot.subscribe, snapshot.getSnapshot, snapshot.getSnapshot)
}

/** Keeps one failing panel from taking the whole UI down, and reports it. */
class PanelBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    diag('render-error', error?.message ?? error)
  }

  render() {
    if (this.state.error !== null) {
      return React.createElement(
        'div',
        { style: { padding: 24, opacity: 0.8 } },
        seat(this.props)('render.failed', { message: String(this.state.error) }),
      )
    }
    return this.props.children
  }
}

const EMPTY = {
  enabled: false,
  hostname: '',
  state: 'idle',
  link: '',
  port: 0,
  detail: '',
  detailCode: '',
  detailParams: {},
  sessionOnly: false,
  updatedAt: '',
}

function stateDotOf(state) {
  if (state === 'on') return 'done'
  if (state === 'pending') return 'ongoing'
  if (state === 'error') return 'error'
  return 'idle'
}

function labelOf(t, state, enabled) {
  if (state === 'on') return t('state.on')
  if (state === 'pending') return t('state.pending')
  if (state === 'error') return t('state.error')
  return enabled ? t('state.syncing') : t('state.off')
}

async function copyText(text) {
  if (writeClipboard !== null) {
    try {
      await writeClipboard(text)
      return true
    } catch {
      /* fall through to the local implementations */
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * Live status from the host route, shaped as the framework's snapshot contract
 * (`getSnapshot` / `subscribe`), which is what an injected `hooks.<name>` expects.
 */
function createStatusSource() {
  let snapshot = { loading: true, value: EMPTY, error: null }
  /** Poll cadence: fast while the panel is open, slow for the sidebar dot alone. */
  let cadence = IDLE_POLL_MS
  let timer = null
  /** E1: nothing changes while the tab is hidden, so stop burning requests. */
  const onVisibility = () => {
    if (document.hidden) {
      unschedule()
    } else {
      poll()
      schedule()
    }
  }
  const poll = () => {
    void refresh()
  }
  const schedule = () => {
    if (timer !== null) return
    timer = setInterval(poll, cadence)
  }
  const unschedule = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }
  const stop = () => {
    unschedule()
    document.removeEventListener('visibilitychange', onVisibility)
  }
  const listeners = new Set()
  let inFlight = false

  const publish = (next) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const refresh = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const response = await fetch(STATUS_URL, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 401 || response.status === 403) {
        publish({ loading: false, value: EMPTY, error: { key: 'error.auth' } })
        return
      }
      if (!response.ok) {
        publish({ loading: false, value: EMPTY, error: { key: 'error.http', params: { status: response.status } } })
        return
      }
      const value = await response.json()
      debugEnabled = value?.debug === true
      if (debugEnabled) flushDiag()
      publish({ loading: false, value: { ...EMPTY, ...value }, error: null })
    } catch (error) {
      publish({
        loading: false,
        value: snapshot.value,
        error: { key: 'error.network', params: { message: String(error?.message ?? error) } },
      })
    } finally {
      inFlight = false
    }
  }

  return {
    hooks: {
      status: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      },
    },
    refresh,
    setEnabled: async (next) => {
      publish({ ...snapshot, value: { ...snapshot.value, enabled: next }, error: null })
      const response = await fetch(SET_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!response.ok) {
        publish({
          ...snapshot,
          error: { key: 'error.toggleHttp', params: { status: response.status } },
        })
        return
      }
      const value = await response.json()
      debugEnabled = value?.debug === true
      if (debugEnabled) flushDiag()
      publish({ loading: false, value: { ...EMPTY, ...value }, error: null })
    },
    /** The panel is a keyed slot: it unmounts when another panel is selected. */
    setActive(active) {
      cadence = active ? POLL_MS : IDLE_POLL_MS
      if (timer !== null && !document.hidden) {
        unschedule()
        schedule()
      }
    },
    start() {
      void refresh()
      schedule()
      document.addEventListener('visibilitychange', onVisibility)
      return stop
    },
  }
}

/** Sidebar glyph: link icon with a status-dot badge (decorative; the row label carries the meaning). */
function PanelIcon({ size, statusSnapshot }) {
  const status = readStatus(statusSnapshot)
  const state = status?.value?.state ?? 'idle'
  return React.createElement(
    'span',
    { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
    React.createElement(LinkIconRegular, { kind: 'url', size }),
    React.createElement(
      'span',
      { style: { position: 'absolute', right: -4, bottom: -3, lineHeight: 0 } },
      React.createElement(StateDot, { state: stateDotOf(state), size: 8 }),
    ),
  )
}

/**
 * QR of the launch link, so a phone can scan instead of receiving the string.
 *
 * Sizing matters more than it looks: QR needs a quiet zone of ≥4 modules, and
 * modules that are too small (or a container that scales them down) are what
 * makes a phone camera fail. cellSize is computed from the symbol's module
 * count so the rendered code lands near `target` px with an integral cell.
 */
function QrCode({ text, target = 240, t = fallbackT }) {
  const rendered = React.useMemo(() => {
    try {
      const qr = qrcode(0, 'M')
      qr.addData(text)
      qr.make()
      const count = qr.getModuleCount()
      const cell = Math.max(4, Math.floor(target / (count + 8)))
      const margin = cell * 4
      const svg = qr.createSvgTag({ cellSize: cell, margin })
      const px = count * cell + margin * 2
      diag('qr-encoded', JSON.stringify({ hasToken: true, modules: count, cell, px }))
      return { svg, px }
    } catch (error) {
      diag('qr-error', error?.message ?? error)
      return { svg: '', px: 0 }
    }
  }, [text, target])

  if (rendered.svg.length === 0) {
    return React.createElement(
      'div',
      { style: { ...muted, fontSize: 12, maxWidth: 240 } },
      t('qr.failed'),
    )
  }
  return React.createElement('div', {
    style: {
      width: rendered.px + 16,
      height: rendered.px + 16,
      background: '#fff',
      padding: 8,
      borderRadius: 8,
      flex: '0 0 auto',
      boxSizing: 'content-box',
    },
    // The generator emits a self-contained <svg>; no user-controlled HTML enters it.
    dangerouslySetInnerHTML: { __html: rendered.svg },
  })
}

/**
 * Panel body, deliberately minimal:
 *   switch + status (one row) · one QR · the fallback link · a "?" disclosure.
 * The pairing code lives inside the QR only — the user scans it, they never type it.
 */
function PanelPage(props) {
  const { statusSnapshot, onSetEnabled, onPanelActive } = props
  const t = seat(props)
  const status = readStatus(statusSnapshot)
  const value = status?.value ?? EMPTY
  const enabled = value.enabled === true
  const state = value.state ?? 'idle'
  const link = typeof value.link === 'string' ? value.link : ''
  const hostname = typeof value.hostname === 'string' ? value.hostname : ''
  const pairUrl = typeof value.pairUrl === 'string' ? value.pairUrl : ''
  // HTTPS omits :443; a custom serve port must be visible, or the link looks broken.
  const servePort = Number(value.servePort ?? 443) || 443
  const portSuffix = servePort === 443 ? '' : `:${String(servePort)}`
  /**
   * A failure line: the host's own Chinese text is the fallback for any code this
   * build does not ship a translation for (a newer host, an older client).
   */
  const detailCode = typeof value.detailCode === 'string' ? value.detailCode : ''
  const detailText =
    detailCode.length > 0 && KNOWN_DETAIL_CODES.has(detailCode)
      ? t(`detail.${detailCode}`, value.detailParams ?? {})
      : typeof value.detail === 'string'
        ? value.detail
        : ''
  const detail = value.sessionOnly === true ? `${detailText}${t('detail.sessionOnly')}`.trim() : detailText
  const requestError = status?.error
  const [copied, setCopied] = React.useState(false)
  const [showHelp, setShowHelp] = React.useState(false)
  const copyTimer = React.useRef(null)
  /** Flash the "copied" label briefly, then go back to "copy" so the button stays usable. */
  const flashCopied = () => {
    setCopied(true)
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null
      setCopied(false)
    }, 1600)
  }
  React.useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    },
    [],
  )
  // E1: the panel is a keyed slot, so unmounting it is the "panel closed" signal.
  React.useEffect(() => {
    onPanelActive?.(true)
    return () => onPanelActive?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const previousEnabled = React.useRef(enabled)

  // Copy the fallback link once, on the off -> on edge.
  React.useEffect(() => {
    if (!previousEnabled.current && enabled && state === 'on' && link.length > 0) {
      void copyText(link).then((ok) => {
        if (ok) flashCopied()
      })
    }
    if (!enabled) setCopied(false)
    previousEnabled.current = enabled
  }, [enabled, state, link])

  const helpButton = {
    width: 20,
    height: 20,
    borderRadius: 10,
    border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
    background: 'none',
    color: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    cursor: 'pointer',
    padding: 0,
    flex: '0 0 auto',
  }

  return React.createElement(
    'div',
    {
      style: {
        // Fixed geometry: the panel must not re-center or re-flow when the
        // content changes size between the ON and OFF states.
        width: '100%',
        maxWidth: 680,
        boxSizing: 'border-box',
        alignSelf: 'stretch',
        textAlign: 'left',
        padding: '28px 32px',
        margin: '0 auto',
        font: 'inherit',
      },
    },

    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 } },
      React.createElement('h1', { style: { fontSize: 20, margin: 0 } }, t('panel.title')),
      React.createElement(
        'button',
        {
          type: 'button',
          title: t('panel.helpLabel'),
          'aria-label': t('panel.helpLabel'),
          style: helpButton,
          onClick: () => setShowHelp((open) => !open),
        },
        '?',
      ),
    ),

    React.createElement(
      'div',
      { style: { ...row, marginBottom: 20 } },
      React.createElement(Switch, {
        checked: enabled,
        disabled: state === 'pending',
        label: t('switch.label'),
        onChange: (next) => {
          void Promise.resolve(onSetEnabled(next)).catch(() => {})
        },
      }),
      React.createElement(StateDot, { state: stateDotOf(state), size: 8 }),
      React.createElement(
        'span',
        { style: { fontSize: 14 } },
        labelOf(t, state, enabled),
        hostname.length > 0
          ? React.createElement('span', { style: muted }, ` · ${hostname}${portSuffix}`)
          : null,
      ),
    ),

    pairUrl.length === 0 &&
      link.length === 0 &&
      state !== 'error' &&
      React.createElement('p', { style: { ...muted, fontSize: 13, marginTop: 4 } }, t('hint.enable')),

    pairUrl.length > 0 &&
      React.createElement(
        'div',
        { style: { display: 'flex', gap: 22, alignItems: 'center', marginBottom: 20 } },
        React.createElement(QrCode, { text: pairUrl, requireToken: false, t }),
        React.createElement(
          'div',
          { style: { fontSize: 14, lineHeight: 1.8 } },
          t('qr.scan'),
          React.createElement('br'),
          t('qr.enter'),
        ),
      ),

    link.length > 0 &&
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
            borderRadius: 10,
            padding: '6px 6px 6px 12px',
            marginBottom: 8,
          },
        },
        React.createElement(
          'code',
          { style: { flex: 1, minWidth: 0, wordBreak: 'break-all', fontSize: 11, lineHeight: 1.5, ...muted } },
          link,
        ),
        React.createElement(
          Button,
          {
            size: 'sm',
            variant: 'outline',
            onClick: () => {
              void copyText(link).then((ok) => {
                if (ok) flashCopied()
              })
            },
          },
          copied ? t('copy.copied') : t('copy.copy'),
        ),
      ),

    state === 'error' &&
      detail.length > 0 &&
      React.createElement('p', { style: { color: '#d64545', fontSize: 13, marginBottom: 8 } }, detail),
    requestError &&
      React.createElement(
        'p',
        { style: { color: '#d64545', fontSize: 13 } },
        t(requestError.key, requestError.params),
      ),

    showHelp &&
      React.createElement(
        'div',
        {
          style: {
            ...muted,
            fontSize: 12,
            lineHeight: 1.9,
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
          },
        },
        ...[
          t('help.1'),
          t('help.2'),
          t('help.3', { host: `${hostname.length > 0 ? hostname : '<tailnet domain>'}${portSuffix}` }),
          t('help.4'),
        ].map((text, index) =>
          React.createElement(
            'div',
            { key: text, style: { display: 'flex', gap: 8 } },
            React.createElement('span', { style: { minWidth: 12, textAlign: 'right', ...muted } }, String(index + 1)),
            React.createElement('span', null, text),
          ),
        ),
      ),
  )
}

/**
 * Register both contributions.
 *
 * The copy rides the harness's own `locale` service rather than a private
 * language flag: `locale: NS` on each registration hands the component the
 * framework `t` seat, and the renderer subscribes every outlet to the locale
 * revision — so flipping the language in Settings → General re-renders this
 * panel in place, and the sidebar label re-resolves through the thunk below.
 *
 * @param ctx - client root context.
 */
export function apply(ctx) {
  diag('apply', JSON.stringify({ hasSlots: Boolean(ctx.slots), hasEffect: typeof ctx.effect }))
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tailscale-remote: dictionaries')
    /** Live-bound: follows the active locale at call time (the sidebar re-resolves labels on change). */
    const t = ctx.locale.bind(NS)
    const source = createStatusSource()
    const shared = { statusSnapshot: source.hooks.status }

    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          locale: NS,
          label: () => t('panel.title'),
          inject: () => shared,
        },
        PanelIcon,
      ),
    )

    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({
            ...shared,
            onSetEnabled: (next) => source.setEnabled(next),
            onPanelActive: (active) => source.setActive(active),
          }),
        },
        function BoundedPanelPage(props) {
          return React.createElement(
            PanelBoundary,
            { t: seat(props) },
            React.createElement(PanelPage, props),
          )
        },
      ),
    )

    ctx.effect(() => source.start(), 'tailscale-remote: status polling')
    diag('apply-ok')
  } catch (error) {
    diag('apply-error', error?.message ?? error)
    throw error
  }
}
