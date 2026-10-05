/**
 * dsh-tailscale-remote — host half.
 *
 * One `tailscale serve` mapping behind a switch, plus the routes the panel uses.
 *
 * Design notes that matter:
 * - The switch is this plugin's own volatile Config field, so changing it reaches
 *   the running reference through the loader's volatile commit.
 * - The launch link carries the process token, so it is NEVER persisted; it is
 *   served by an exact route under `/api`, admitted through the connection
 *   service's own fence + session gate.
 * - `tailscale serve` is machine-global. Before turning a mapping off we check
 *   that the live mapping is the one WE created; otherwise we leave the machine
 *   alone and say so, instead of clobbering another instance's config.
 * - The pairing page exists because a cross-app navigation (camera → browser)
 *   makes Chromium refuse the `SameSite=Strict` session cookie; a tap inside the
 *   page keeps the whole chain same-site.
 *
 * @module dsh-tailscale-remote
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'

const execFileAsync = promisify(execFile)

/** Stable Cordis plugin name (also the profile entry id / settings form key). */
export const name = 'tailscale-remote'

/** Services required before the switch can do anything. */
export const inject = ['webServer', 'connection', 'settings']

/**
 * Mark a field volatile when the host's schemastery build supports it (DSH's
 * `@deepseek-ai/schemastery` >= 3.18.4). The plain npm `schemastery` has no
 * `.volatile()`, and calling it blindly throws at module evaluation — which the
 * loader reports only as "failed to import".
 */
const vol = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema)

/** A bare authority (host or host:port) — the only shape accepted for `hostname`. */
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/

/**
 * Decide whether this machine can actually serve the harness over Tailscale,
 * from one \`tailscale status --json\` payload. Exported and pure so it can be
 * tested without a tailnet (this plugin previously had no automated tests at all).
 *
 * Throws a user-facing Error for every condition that would otherwise surface on
 * the phone as an unexplained timeout or TLS failure.
 *
 * @param status - parsed \`tailscale status --json\`
 * @param options - \`bin\` (for the ENOENT message) and \`override\` (configured hostname)
 */
export function classifyTailnet(status, options = {}) {
  const bin = String(options.bin ?? 'tailscale')
  const override = String(options.override ?? '').trim()
  if (override.length > 0 && !HOSTNAME_PATTERN.test(override)) {
    throw new Error(`hostname 配置不合法（只允许纯主机名，不含端口/协议/路径）：${JSON.stringify(override)}`)
  }

  const backend = String(status?.BackendState ?? '')
  if (backend !== 'Running') {
    const hint =
      backend === 'NeedsLogin'
        ? '需要登录 Tailscale'
        : backend === 'Stopped'
          ? '未运行：请打开 Tailscale 客户端并连接'
          : backend === 'Starting'
            ? '正在启动：请稍后重试'
            : '状态异常：请检查 Tailscale 客户端'
    throw new Error(`Tailscale 不可用（BackendState=${backend || '未知'}）：${hint}`)
  }

  const dns = override.length > 0 ? override : String(status?.Self?.DNSName ?? '').replace(/\.$/, '')
  if (dns.length === 0) throw new Error('Tailscale 已运行但未返回本机域名（Self.DNSName 为空）')
  if (!HOSTNAME_PATTERN.test(dns)) throw new Error(`tailnet 域名不合法：${JSON.stringify(dns)}`)

  if (status?.CurrentTailnet?.MagicDNSEnabled !== true) {
    throw new Error('tailnet 未启用 MagicDNS：域名无法解析，请在 Tailscale 管理台开启 MagicDNS')
  }

  const certDomains = Array.isArray(status?.CertDomains) ? status.CertDomains.map((item) => String(item)) : []
  if (!certDomains.includes(dns)) {
    throw new Error(`未找到 ${dns} 的 HTTPS 证书：请在 Tailscale 管理台开启 HTTPS Certificates 后重试`)
  }

  const health = Array.isArray(status?.Health) ? status.Health.map((item) => String(item)).slice(0, 3) : []
  const peers = Object.values(status?.Peer ?? {})
  return {
    hostname: dns,
    backend,
    bin,
    health,
    peersOnline: peers.filter((peer) => peer?.Online === true).length,
    peersTotal: peers.length,
  }
}

/** Plugin configuration. */
export const Config = z.object({
  /** The switch. Volatile: edited live, persisted by the configuration editor. */
  enabled: vol(z.boolean().default(false)),
  /** Tailnet DNS name override; empty discovers it from `tailscale status --json`. */
  hostname: vol(z.string().default('')),
  /** Tailscale CLI binary. */
  tailscaleBin: z.string().default('tailscale'),
  /** HTTPS listener port of the serve mapping. */
  servePort: z.number().default(443),
  /** Serve the one-time pairing page (first-time login for browsers that block cross-app cookies). */
  pairing: z.boolean().default(true),
  /** Diagnostics channel and scan-path echo. Off by default: a released plugin ships no debug surface. */
  debug: z.boolean().default(false),
})

/** Routes. */
const STATUS_PATH = '/api/tailscale-remote.status'
const SET_PATH = '/api/tailscale-remote.set'
const DIAG_PATH = '/api/tailscale-remote.diag'
const ECHO_PATH = '/tailscale-probe'
const PAIR_PATH = '/tailscale-pair'

/** Debug-only breadcrumb file (macOS: under $TMPDIR). */
const DIAG_FILE = join(tmpdir(), 'dsh-tailscale-diag.log')

/** Pairing code lifetime and attempt budget. */
const PAIR_TTL_MS = 10 * 60 * 1000
const PAIR_MAX_ATTEMPTS = 10
const PAIR_ATTEMPT_WINDOW_MS = 60 * 1000

/**
 * Mount the switch, its routes, and the pairing page.
 * @param ctx - host context carrying `webServer`, `connection`, and `settings`.
 * @param config - see {@link Config}; volatile members are live references.
 */
export function apply(ctx, config = {}) {
  const read = (reference, fallback) => {
    if (reference === undefined || reference === null) return fallback
    if (typeof reference?.get === 'function') return reference.get()
    return reference
  }
  const servePort = Number(read(config.servePort, 443)) || 443
  const bin = String(read(config.tailscaleBin, 'tailscale') || 'tailscale')
  const pairingEnabled = () => read(config.pairing, true) !== false
  const isDebug = () => read(config.debug, false) === true

  /** Session-only override, used only when the settings write path is unavailable. */
  let override = null
  let overrideAt = 0
  /** Last value we reconciled to; repeated reconciles become no-ops. */
  let appliedEnabled = null
  /** The loopback port this process last mapped; null = we own no mapping. */
  let ownedPort = null

  /** The authority THIS plugin appended to the harness fence at runtime (so it can be removed on disable). */
  let injectedAuthority = null
  let pairCode = ''
  let pairIssuedAt = 0
  let pairAttempts = []
  const probeMarker = `probe-${randomBytes(4).toString('hex')}`

  let state = {
    enabled: false,
    hostname: '',
    state: 'idle',
    link: '',
    port: 0,
    pairCode: '',
    pairUrl: '',
    tailnet: null,
    detail: '尚未同步',
    updatedAt: '',
  }

  const isEnabled = () =>
    override !== null && Date.now() - overrideAt < 5 * 60 * 1000 ? override : read(config.enabled, false) === true

  const log = (...args) => {
    try {
      ;(ctx.logger?.('tailscale-remote') ?? console).info?.(...args)
    } catch {
      /* logging must never break the switch */
    }
  }

  /** Append one diagnostic line (see DIAG_FILE); a no-op unless `debug` is on. */
  const breadcrumb = (event, detail = '') => {
    if (!isDebug()) return
    void appendFile(DIAG_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, detail: String(detail) })}\n`, {
      mode: 0o600,
    }).catch(() => {})
  }

  async function run(args) {
    const { stdout } = await execFileAsync(bin, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  }

  /**
   * Preflight: fetch \`tailscale status --json\` (mapping a missing CLI to a readable
   * error) and hand it to {@link classifyTailnet}.
   */
  async function preflight() {
    const override = String(read(config.hostname, '') || '').trim()
    let parsed
    try {
      parsed = JSON.parse(await run(['status', '--json']))
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/ENOENT/.test(message)) {
        throw new Error(
          `找不到 tailscale 可执行文件（tailscaleBin=${JSON.stringify(bin)}）：请安装 Tailscale 客户端，或把 tailscaleBin 配成绝对路径`,
        )
      }
      throw new Error(`无法读取 Tailscale 状态：${message}`)
    }
    return classifyTailnet(parsed, { bin, override })
  }

  /**
   * Ask the harness's own `/api` surface how it reads a request for the tailnet
   * authority. `/` is useless here: the trust fence only guards `/api`, so an
   * untrusted authority still answers 401 there and the check would always pass.
   *
   * 401 → fence accepted the authority, no browser session yet (what we want)
   * 403 → fence refused the authority (trustedHosts missing / stale)
   * 0 or anything else → inconclusive, treated as failure
   */
  function probeTrust(port, hostname) {
    return new Promise((resolve) => {
      const req = request(
        { host: '127.0.0.1', port, path: STATUS_PATH, method: 'GET', headers: { Host: hostname } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', () => resolve(0))
      req.setTimeout(5000, () => {
        req.destroy()
        resolve(0)
      })
      req.end()
    })
  }

  async function waitForPort() {
    for (let i = 0; i < 40; i += 1) {
      const port = ctx.webServer?.port
      if (typeof port === 'number' && port > 0) return port
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('web server 未在超时内绑定端口')
  }

  /**
   * Is the root handler of OUR https port still proxying to \`port\`?
   * Parsed from \`serve status --json\` rather than the human-readable text, whose
   * column layout is not a contract (E2/F19).
   */
  /** The root proxy target currently registered on OUR https port, or null. */
  async function rootTargetOnPort() {
    try {
      const parsed = JSON.parse(await run(['serve', 'status', '--json']))
      const web = parsed?.Web ?? {}
      for (const [key, value] of Object.entries(web)) {
        if (!key.endsWith(`:${String(servePort)}`)) continue
        const proxy = value?.Handlers?.['/']?.Proxy
        if (typeof proxy === 'string') return proxy
      }
      return null
    } catch {
      return null
    }
  }

  async function ownsRootMapping(port) {
    try {
      const parsed = JSON.parse(await run(['serve', 'status', '--json']))
      const web = parsed?.Web ?? {}
      for (const [key, value] of Object.entries(web)) {
        if (!key.endsWith(`:${String(servePort)}`)) continue
        if (value?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${String(port)}`) return true
      }
      return false
    } catch {
      return false
    }
  }

  /** The authority a phone must dial: HTTPS omits :443, so a custom port must be explicit. */
  const authority = (hostname) => (servePort === 443 ? hostname : `${hostname}:${String(servePort)}`)

  const tokenOf = () => {
    try {
      return new URL(ctx.connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token') ?? ''
    } catch {
      return ''
    }
  }

  function mintPairCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = randomBytes(8)
    pairCode = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
    pairIssuedAt = Date.now()
    pairAttempts = []
  }

  /** Mint when there is no live code — the panel's QR must never point at a dead one. */
  function ensurePairCode() {
    if (pairCode.length === 0 || Date.now() - pairIssuedAt >= PAIR_TTL_MS) mintPairCode()
  }

  /**
   * Register our tailnet authority with the harness's own Host/Origin fence.
   *
   * The connection service keeps `trustedHosts` as an instance array and re-reads it
   * on every request, so a plugin can extend trust at runtime instead of asking the
   * user to patch the profile (which is what scripts/setup.mjs does — still supported,
   * and the two are additive). Without this the phone could load the page but every
   * `/api` call would be answered 403.
   *
   * Only a bare authority that passes the same whitelist as the config is accepted.
   * @returns 'added' | 'present' | 'unavailable'
   */
  function registerTrustedAuthority(hostname) {
    if (typeof hostname !== 'string' || !HOSTNAME_PATTERN.test(hostname)) return 'unavailable'
    const list = ctx.connection?.trustedHosts
    if (!Array.isArray(list)) return 'unavailable'
    if (list.includes(hostname)) return 'present'
    list.push(hostname)
    log(`trusted authority registered at runtime: ${hostname}`)
    return 'added'
  }

  /** Remove only what we added; a declarative profile entry stays untouched. */
  function unregisterTrustedAuthority() {
    if (injectedAuthority === null) return
    const list = ctx.connection?.trustedHosts
    if (Array.isArray(list)) {
      const at = list.indexOf(injectedAuthority)
      if (at !== -1) list.splice(at, 1)
    }
    injectedAuthority = null
  }

  const validPairCode = (candidate) =>
    pairCode.length > 0 &&
    Date.now() - pairIssuedAt < PAIR_TTL_MS &&
    String(candidate ?? '').trim().toUpperCase() === pairCode

  function pairRateLimited() {
    const now = Date.now()
    pairAttempts = pairAttempts.filter((at) => now - at < PAIR_ATTEMPT_WINDOW_MS)
    if (pairAttempts.length >= PAIR_MAX_ATTEMPTS) return true
    pairAttempts.push(now)
    return false
  }

  /**
   * The status payload, composed from LIVE values. Serving the pairing fields out
   * of \`state\` meant the panel kept drawing the code that had just been consumed
   * (or one that expired ten minutes ago) — a guaranteed 404 (F1/round-2 ①a).
   */
  function liveStatus() {
    const debugOn = isDebug()
    const pairingOn = pairingEnabled() && state.enabled === true && state.state === 'on'
    if (pairingOn) ensurePairCode()
    const livePair = pairingOn && pairCode.length > 0 ? pairCode : ''
    return {
      ...state,
      debug: debugOn,
      pairCode: livePair,
      servePort,
      pairUrl:
        livePair.length > 0 ? `https://${authority(state.hostname)}${PAIR_PATH}?c=${livePair}` : '',
      probeUrl:
        debugOn && state.hostname.length > 0
          ? `https://${authority(state.hostname)}${ECHO_PATH}?marker=${probeMarker}`
          : '',
    }
  }

  const errorState = (detail, extra = {}) => ({
    ...state,
    ...extra,
    // A token link — and a pairing QR — are worthless while the fence refuses
    // the authority: clearing them keeps the panel from offering a dead end.
    link: '',
    pairCode: '',
    pairUrl: '',
    state: 'error',
    detail,
    updatedAt: new Date().toISOString(),
  })

  /**
   * Bring reality in line with the switch. Serialized: a call made while one is
   * running waits for it rather than reporting a stale state, and a rejected
   * work promise never surfaces as an unhandled rejection (the host treats those
   * as fatal).
   */
  let inflight = Promise.resolve()
  function reconcile(reason = 'manual') {
    const work = async () => {
      let enabled = false
      try {
        enabled = isEnabled()
      } catch (error) {
        log('config read failed:', String(error?.message ?? error))
        return state
      }
      try {
        if (reason !== 'boot' && enabled === appliedEnabled && state.state !== 'error') return state
        appliedEnabled = enabled

        if (!enabled) {
          // Only remove a mapping this process created; `tailscale serve` is global.
          let revoked = false
          if (ownedPort !== null) {
            if (await ownsRootMapping(ownedPort)) {
              await run(['serve', `--https=${String(servePort)}`, 'off'])
              revoked = true
            } else {
              log('serve mapping no longer points at us; leaving it untouched')
            }
            ownedPort = null
          }
          unregisterTrustedAuthority()
          const offDetail = revoked
            ? '已关闭（本插件建立的映射已撤销）'
            : state.state !== 'on'
              ? '已关闭'
              : '已关闭（未发现属于本插件的映射，未改动机器上其他 serve 配置）'
          pairCode = ''
          state = {
            enabled: false,
            hostname: '',
            state: 'off',
            link: '',
            port: 0,
            pairCode: '',
            pairUrl: '',
            tailnet: null,
            detail: offDetail,
            updatedAt: new Date().toISOString(),
          }
          return state
        }

        const env = await preflight()
        const hostname = env.hostname
        // Fence first, then the serve mapping: the self-check below is only
        // meaningful once the harness accepts this authority.
        const fence = registerTrustedAuthority(hostname)
        if (fence === 'added') injectedAuthority = hostname
        state = {
          ...state,
          enabled: true,
          hostname,
          tailnet: {
            backend: env.backend,
            peersOnline: env.peersOnline,
            peersTotal: env.peersTotal,
            health: env.health,
            fence,
          },
          state: 'pending',
          detail: '正在启用…',
          link: '',
          pairCode: '',
          pairUrl: '',
        }

        const port = await waitForPort()
        // S-3: a non-loopback bind widens the exposure beyond the tailnet; the plugin
        // never sets this value, so it can only be reported, not corrected.
        const bindHost = String(ctx.webServer?.host ?? '')
        const loopbackBind =
          bindHost === '' || bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1'
        // Claiming a port that already serves something else would silently steal it
        // (tailscale replaces the port's root handler). Refuse instead.
        const occupant = await rootTargetOnPort()
        if (occupant !== null && occupant !== `http://127.0.0.1:${String(port)}`) {
          state = errorState(
            `端口 ${String(servePort)} 已被另一条 serve 映射占用（→ ${occupant}）：已放弃覆盖。请改 servePort，或先移除该映射。`,
            { enabled: true, hostname },
          )
          return state
        }

        const serveArgs =
          servePort === 443
            ? ['serve', '--bg', String(port)]
            : ['serve', '--bg', `--https=${String(servePort)}`, String(port)]
        await run(serveArgs)
        ownedPort = port

        const link = ctx.connection.authenticatedUrl(`https://${authority(hostname)}/`)
        // Probe with a short retry: a single timeout must not tear down a working
        // channel (S-1 revokes the mapping on a definitive failure), while 403 is
        // deterministic and answered on the first try.
        let code = 0
        for (let attempt = 0; attempt < 3; attempt += 1) {
          code = await probeTrust(port, hostname)
          if (code === 401 || code === 403) break
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
        const updatedAt = new Date().toISOString()

        if (code !== 401) {
          // S-1: revoke what we just created. A channel whose /api calls all fail is
          // worse than none — the panel would read "error" while the tailnet path
          // stayed open.
          try {
            if (await ownsRootMapping(port)) {
              await run(['serve', `--https=${String(servePort)}`, 'off'])
            }
          } catch (error) {
            log('failed to revoke the mapping after a failed self-check:', String(error?.message ?? error))
          }
          ownedPort = null
          const detail =
            code === 403
              ? `域名未通过信任栅栏（403）：https://${authority(hostname)}/ 。请运行 scripts/setup.sh 写入 trustedHosts 后重启。`
              : `自检未通过（HTTP ${String(code)}）：无法确认 /api 是否接受该 authority。`
          state = errorState(detail, { enabled: true, hostname, port })
          return state
        }

        if (!pairingEnabled()) pairCode = ''

        state = {
          enabled: true,
          hostname,
          state: 'on',
          link,
          port,
          pairCode,
          pairUrl: pairCode.length > 0 ? `https://${authority(hostname)}${PAIR_PATH}?c=${pairCode}` : '',
          tailnet: {
            backend: env.backend,
            peersOnline: env.peersOnline,
            peersTotal: env.peersTotal,
            health: env.health,
            fence,
          },
          detail: [
            loopbackBind ? '' : `⚠️ harness 绑定在 ${bindHost}（非回环）：同网段设备也能访问`,
            env.health.length > 0 ? `Tailscale 告警：${env.health.join('；')}` : '',
          ]
            .filter((part) => part.length > 0)
            .join(' · '),
          updatedAt,
        }
        log(`remote access on: https://${authority(hostname)}/ (loopback ${String(port)})`)
        return state
      } catch (error) {
        const message = String(error?.message ?? error)
        log('reconcile failed:', message)
        state = errorState(message, { enabled })
        return state
      }
    }
    inflight = inflight.then(work, work).catch((error) => {
      log('reconcile queue error:', String(error?.message ?? error))
      return state
    })
    return inflight
  }

  /**
   * Flip the switch: persist through the settings service so the volatile commit
   * reaches the running reference. Falls back to a session-only override.
   */
  async function applyEnabled(next) {
    override = null
    try {
      if (typeof ctx.settings?.update !== 'function') throw new Error('settings.update is unavailable')
      await ctx.settings.update(name, { enabled: next })
    } catch (error) {
      override = next
      overrideAt = Date.now()
      log('settings write unavailable, applying for this session only:', String(error?.message ?? error))
    }
    const nextState = await reconcile('manual')
    return override === null
      ? nextState
      : { ...nextState, detail: `${nextState.detail}（本次会话生效，未持久化）`.trim() }
  }

  /**
   * Reuse the connection service's own fence + session gate (the same rules
   * `/api` uses). FAIL CLOSED: with neither method available, these
   * token-bearing routes must refuse rather than silently become unauthenticated.
   */
  function admitted(req) {
    const connection = ctx.connection
    if (typeof connection?.admit === 'function') {
      let admission
      try {
        admission = connection.admit(req)
      } catch {
        return 503
      }
      // A promise (or any unexpected shape) means the contract changed; refuse
      // rather than treat "unknown" as "admitted".
      if (admission !== null && typeof admission === 'object' && typeof admission.then === 'function') return 503
      if (admission === undefined || admission === null || typeof admission !== 'object') return 503
      if (!('rejection' in admission)) return null
      return typeof admission.rejection === 'number' ? admission.rejection : 403
    }
    if (typeof connection?.isAuthenticated === 'function') {
      return connection.isAuthenticated(req) ? null : 401
    }
    return 503
  }

  function reject(res, status) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'unavailable')
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  }

  function sendText(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(html)),
    })
    res.end(html)
  }

  /** Read a small request body, JSON or form-encoded. */
  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024) {
        const error = new Error('body too large')
        error.statusCode = 413
        throw error
      }
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.length === 0) return {}
    if (String(req.headers['content-type'] ?? '').includes('application/json')) {
      try {
        const parsed = JSON.parse(text)
        // \`null\`, arrays and scalars are valid JSON but not bodies we expect; treat
        // them as empty so the caller answers 400 rather than throwing a TypeError.
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        const error = new Error('invalid JSON body')
        error.statusCode = 400
        throw error
      }
    }
    return Object.fromEntries(new URLSearchParams(text))
  }

  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    )

  function pairPage(code) {
    return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>进入 DeepSeek Harness</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;font:16px/1.6 -apple-system,system-ui,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
 main{max-width:420px}
 h1{font-size:20px;margin:0 0 8px}
 p{opacity:.75;font-size:14px}
 button{width:100%;margin-top:16px;padding:14px 18px;font-size:16px;border-radius:12px;border:0;background:#2f6fed;color:#fff}
 code{font-size:13px}
</style></head>
<body><main>
 <h1>进入 DeepSeek Harness</h1>
 <p>点击下面的按钮完成这台设备的登录。这一步由当前页面发起（同站跳转），可以避免浏览器在“外部 App 打开链接”时拒绝保存会话 cookie。</p>
 <form method="post" action="${PAIR_PATH}">
   <input type="hidden" name="c" value="${escapeHtml(code)}">
   <button type="submit">进入 DSH</button>
 </form>
 <p>配对码由这台电脑显示，一次性使用、10 分钟内有效；本页只能从你的 tailnet 内访问。</p>
</main></body></html>`
  }

  /**
   * The pairing route is deliberately unauthenticated (the phone has no session
   * yet), so it is the one place a same-site check is ours to make: a cross-site
   * POST must not be able to redeem a leaked code.
   */
  function sameSiteRequest(req) {
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '')
    if (fetchSite === 'cross-site') return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      try {
        if (new URL(String(origin)).host !== String(req.headers.host ?? '')) return false
      } catch {
        return false
      }
      return true
    }
    if (fetchSite.length > 0) return true
    // Neither header: only accept the encoding our own pairing page uses
    // (round-2 ②a). A non-browser client can forge headers anyway, so this is
    // defence in depth, not a boundary.
    return String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')
  }

  /** Shown when a code is stale: the panel always carries the current one. */
  function pairExpiredPage() {
    return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配对码已失效</title>
<style>body{margin:0;font:16px/1.7 -apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{max-width:420px}h1{font-size:19px;margin:0 0 8px}p{opacity:.75;font-size:14px}</style></head>
<body><main><h1>配对码已失效</h1>
<p>这个配对码已经被使用过或已超过 10 分钟。请回到这台电脑的面板，用**当前显示**的二维码重新扫一次（每次配对成功后，面板会自动换成新码）。</p>
</main></body></html>`
  }

  async function pairHandler(req, res) {
    const url = new URL(String(req.url ?? '/'), 'http://dsh.invalid')
    const fromQuery = url.searchParams.get('c') ?? ''
    if (req.method === 'POST') {
      if (!sameSiteRequest(req)) {
        sendText(res, 403, 'cross-site request refused')
        return
      }
      if (pairRateLimited()) {
        sendText(res, 429, 'too many attempts')
        return
      }
      let submitted = fromQuery
      try {
        const body = await readBody(req)
        if (typeof body.c === 'string') submitted = body.c
      } catch (error) {
        sendText(res, Number(error?.statusCode) || 400, 'bad request')
        return
      }
      if (!validPairCode(submitted)) {
        sendHtml(res, 403, pairExpiredPage())
        return
      }
      const token = tokenOf()
      if (token.length === 0) {
        sendText(res, 503, 'launch token unavailable')
        return
      }
      // S-2: the code is the sole credential for minting a session and it is
      // single-use — record that it was redeemed (never the code or the token).
      log('pairing redeemed', `ua=${String(req.headers['user-agent'] ?? '').slice(0, 48)}`)
      breadcrumb('pair-ok', 'code redeemed')
      // Single use, but re-mint immediately so the panel keeps offering a valid
      // pairing option (the code is only ever shown in the authenticated panel).
      if (pairingEnabled()) mintPairCode()
      else pairCode = ''
      res.writeHead(303, {
        location: `/?token=${encodeURIComponent(token)}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed')
      return
    }
    // F3: no code check here. The page carries no secret, so validating the code
    // on GET only produced an unthrottled "is this code right?" oracle; the check
    // belongs on the rate-limited POST alone (a stale code now fails there with a
    // clear message).
    sendHtml(res, 200, pairPage(fromQuery))
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
          const rejection = admitted(req)
          if (rejection !== null) {
            reject(res, rejection)
            return
          }
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method-not-allowed' })
            return
          }

          sendJson(res, 200, liveStatus())
        },
      }),
    'tailscale-remote: status route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SET_PATH,
        handler: async (req, res) => {
          const rejection = admitted(req)
          if (rejection !== null) {
            reject(res, rejection)
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' })
            return
          }
          try {
            const body = await readBody(req)
            if (typeof body.enabled !== 'boolean') {
              sendJson(res, 400, { error: 'expected {"enabled": boolean}' })
              return
            }
            const next = await applyEnabled(body.enabled)
            // ①a: hand back the same live payload the poll would return, so the
            // panel gets its pairing QR immediately instead of after one poll.
            sendJson(res, 200, { ...liveStatus(), detail: next.detail })
          } catch (error) {
            sendJson(res, Number(error?.statusCode) || 500, { error: String(error?.message ?? error) })
          }
        },
      }),
    'tailscale-remote: set route',
  )

  if (pairingEnabled()) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: PAIR_PATH,
          handler: (req, res) => {
            void pairHandler(req, res).catch((error) => {
              log('pair handler failed:', String(error?.message ?? error))
              try {
                sendText(res, 500, 'pairing failed')
              } catch {
                /* response already gone */
              }
            })
          },
        }),
      'tailscale-remote: pairing page',
    )
  }

  if (isDebug()) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: ECHO_PATH,
          handler: (req, res) => {
            // The marker is random per process and only published through the
            // authenticated status payload; without it this route is invisible
            // (N1: it sits outside /api, so no fence applies).
            const url = new URL(String(req.url ?? '/'), 'http://dsh.invalid')
            if (url.searchParams.get('marker') !== probeMarker) {
              sendText(res, 404, 'not found')
              return
            }
            sendJson(res, 200, {
              at: new Date().toISOString(),
              receivedUrl: String(req.url ?? ''),
              hostHeader: String(req.headers.host ?? ''),
              expectedMarker: probeMarker,
            })
          },
        }),
      'tailscale-remote: scan-path echo route',
    )

    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: DIAG_PATH,
          handler: async (req, res) => {
            const rejection = admitted(req)
            if (rejection !== null) {
              reject(res, rejection)
              return
            }
            try {
              const body = await readBody(req)
              const line = `${JSON.stringify({
                at: new Date().toISOString(),
                event: String(body.event ?? '').slice(0, 64),
                detail: String(body.detail ?? '').slice(0, 512),
              })}\n`
              await appendFile(DIAG_FILE, line, { mode: 0o600 })
              sendJson(res, 200, { ok: true })
            } catch (error) {
              sendJson(res, 400, { error: String(error?.message ?? error) })
            }
          },
        }),
      'tailscale-remote: diag route',
    )
  }

  // The loader is authoritative for volatile Config: a commit clears any
  // session-only override, then we reconcile.
  ctx.on('loader/volatile-update', () => {
    override = null
    void reconcile('event')
  })

  // Boot: re-assert the mapping (the OS-assigned port changes between runs).
  breadcrumb('host-apply', `enabled=${String(isEnabled())} port=${String(ctx.webServer?.port)}`)
  ctx.effect(() => {
    const timer = setTimeout(() => {
      reconcile('boot')
        .then((next) => {
          breadcrumb('host-boot-reconcile', `state=${next.state} detail=${next.detail}`)
        })
        .catch((error) => {
          log('boot reconcile failed:', String(error?.message ?? error))
        })
    }, 1200)
    return () => {
      clearTimeout(timer)
    }
  }, 'tailscale-remote: reconcile on boot')
}
