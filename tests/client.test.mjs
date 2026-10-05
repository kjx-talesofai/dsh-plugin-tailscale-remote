/**
 * Client-half smoke test — loads the BUILT bundle and actually runs it.
 *
 * Why this exists: the `timer is not defined` panel crash came from a method that
 * referenced a variable living in another function's closure. Syntax checks and
 * greps cannot see that; only running the code can. This harness stubs the few
 * platform globals the browser half touches (`window.__ModuleLoader__`, `react`,
 * the UI primitives, `fetch`, `document`, `navigator`), renders the registered
 * `sidebar.panellist` row and `main` panel, and runs their effects — i.e. the
 * exact path that crashed.
 *
 *   node tools/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = process.env.CLIENT_BUNDLE ?? join(here, '..', 'lib', 'client.js')

const failures = []
const check = (label, condition) => {
  if (condition) {
    console.log(`✅ ${label}`)
  } else {
    failures.push(label)
    console.log(`❌ ${label}`)
  }
}

// ---- platform stubs -------------------------------------------------------
const effects = []
const cleanups = []
let fetchCalls = 0

const react = {
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) }
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useEffect: (effect) => {
    effects.push(effect)
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Component: class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
    setState() {}
  },
  Fragment: 'Fragment',
}

const primitives = {
  Button: 'Button',
  Switch: 'Switch',
  StateDot: 'StateDot',
  LinkIconRegular: 'LinkIconRegular',
}

const STATUS_PAYLOAD = {
  enabled: true,
  hostname: 'jiaxin-mbpm2.taila3698f.ts.net',
  state: 'on',
  link: 'https://jiaxin-mbpm2.taila3698f.ts.net/?token=FAKE-TOKEN-FOR-TEST',
  port: 19387,
  pairCode: 'ABCDEFGH',
  pairUrl: 'https://jiaxin-mbpm2.taila3698f.ts.net/tailscale-pair?c=ABCDEFGH',
  tailnet: { backend: 'Running', peersOnline: 1, peersTotal: 2, health: [] },
  detail: '',
  debug: false,
  updatedAt: new Date().toISOString(),
}

globalThis.fetch = async (url) => {
  fetchCalls += 1
  if (String(url).includes('.diag')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
  return { ok: true, status: 200, json: async () => STATUS_PAYLOAD }
}
globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  execCommand: () => true,
  createElement: () => ({ style: {}, select() {}, remove() {}, appendChild() {} }),
  body: { appendChild() {}, removeChild() {} },
}
// Node exposes a read-only `navigator`; override the property descriptor instead.
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true })

// Timer spies: the copy button must schedule (and replace) its own reset timer.
let setTimeoutCalls = 0
let clearTimeoutCalls = 0
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = (...args) => {
  setTimeoutCalls += 1
  return realSetTimeout(...args)
}
globalThis.clearTimeout = (...args) => {
  clearTimeoutCalls += 1
  return realClearTimeout(...args)
}

// ---- load the built bundle ------------------------------------------------
let entry = null
const windowStub = { __ModuleLoader__: { load: (value) => { entry = value } } }
try {
  // The bundle is a plain script that registers itself on window.__ModuleLoader__.
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(bundlePath, 'utf8'))(windowStub)
} catch (error) {
  console.log(`❌ 加载 bundle 抛错：${error?.message ?? error}`)
  process.exit(1)
}
check('bundle 注册成功（window.__ModuleLoader__.load 被调用）', entry !== null)
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
check(`bundle id 正确（${packageJson.name}）`, entry?.id === packageJson.name)
check('factory 是函数', typeof entry?.factory === 'function')

const requireStub = (name) => {
  if (name === 'react') return react
  if (name === 'react-dom') return {}
  if (name === 'react/jsx-runtime') return {}
  if (String(name).includes('dsh-client-ui-primitives')) return primitives
  throw new Error(`unexpected require: ${name}`)
}

let module = null
try {
  module = entry.factory(requireStub)
} catch (error) {
  console.log(`❌ factory 抛错：${error?.message ?? error}`)
  process.exit(1)
}
check('factory 返回 apply()', typeof module?.apply === 'function')

// ---- fake host context ----------------------------------------------------
const registrations = []
const ctx = {
  slots: {
    inject: (_kind, contribute) => {
      contribute()
    },
    register: (descriptor, component) => {
      registrations.push({ descriptor, component })
      return () => {}
    },
  },
  effect: (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return () => {}
  },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

try {
  module.apply(ctx)
  check('apply(ctx) 未抛错', true)
} catch (error) {
  check(`apply(ctx) 未抛错（实际：${error?.message ?? error}）`, false)
}

const panellist = registrations.find((item) => item.descriptor.name === 'sidebar.panellist')
const main = registrations.find((item) => item.descriptor.name === 'main')
check('注册了 sidebar.panellist', panellist !== undefined)
check('注册了 main 面板', main !== undefined)
check('main 的 key 与 panellist 的 id 相同', main?.descriptor.key === panellist?.descriptor.id)

/** Minimal renderer: walks the element tree, invoking function/class components. */
function render(element) {
  if (element === null || element === undefined || typeof element !== 'object') return element
  const { type, props } = element
  const children = props?.children
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      instance.props = props
      return render(instance.render())
    }
    return render(type(props))
  }
  const kids = children ?? []
  return (Array.isArray(kids) ? kids : [kids]).map((child) =>
    typeof child === 'object' && child !== null && 'type' in child ? render(child) : child,
  )
}

// The sidebar row (icon + status dot)
try {
  const props = main !== undefined ? { statusSnapshot: panellist.descriptor.inject().statusSnapshot, size: 16 } : {}
  render(react.createElement(panellist.component, props))
  check('渲染 sidebar.panellist 未抛错', true)
} catch (error) {
  check(`渲染 sidebar.panellist 未抛错（实际：${error?.message ?? error}）`, false)
}

// The panel body — this is what crashed with "timer is not defined"
let injectProps = {}
try {
  injectProps = main.descriptor.inject()
  render(react.createElement(main.component, injectProps))
  // Run the queued effects (mount) — this calls onPanelActive(true) -> setActive().
  for (const effect of effects.splice(0)) effect()
  check('渲染 main 面板并执行 mount effects 未抛错', true)
  check('mount 后至少有一个 effect 运行', true)
} catch (error) {
  check(`渲染 main 面板并执行 mount effects 未抛错（实际：${error?.message ?? error}）`, false)
}

// Exercise the polling lifecycle explicitly (fast/slow cadence switch).
try {
  injectProps.onPanelActive?.(false)
  injectProps.onPanelActive?.(true)
  check('onPanelActive(false/true) 未抛错', true)
} catch (error) {
  check(`onPanelActive(false/true) 未抛错（实际：${error?.message ?? error}）`, false)
}

// The copy button: clicking it must not throw, must schedule exactly one reset
// timer, and clicking again while "已复制" must replace that timer (the button
// used to stay on "已复制" forever and felt dead).
try {
  // Let the initial `refresh()` land first: until it does the snapshot has no link,
  // and the copy field only exists when there is a link.
  await new Promise((resolve) => realSetTimeout(resolve, 30))
  // Walk the ELEMENT tree (invoking components but keeping host elements), so the
  // Button element itself is still visible — `render()` replaces it with children.
  const buttons = []
  const allTypes = []
  const walkElements = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walkElements(item)
      return
    }
    allTypes.push(typeof node.type === 'string' ? node.type : (node.type?.name || '<fn>'))
    if (node.type === 'Button') buttons.push(node)
    const { type, props } = node
    const children = props?.children
    if (typeof type === 'function') {
      if (type.prototype && typeof type.prototype.render === 'function') {
        const instance = new type(props)
        instance.props = props
        walkElements(instance.render())
        return
      }
      walkElements(type(props))
      return
    }
    const kids = children ?? []
    for (const child of Array.isArray(kids) ? kids : [kids]) walkElements(child)
  }
  walkElements(react.createElement(main.component, injectProps))
  const copyButton = buttons.at(-1)
  if (copyButton === undefined) console.log('   [debug] 见过的元素类型:', [...new Set(allTypes)].join(', '))
  check('渲染结果里存在复制按钮', copyButton !== undefined)
  const before = setTimeoutCalls
  copyButton?.props?.onClick?.()
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  check('点击复制会安排复位计时器', setTimeoutCalls > before)
  const beforeSecond = clearTimeoutCalls
  copyButton?.props?.onClick?.()
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  check('再次点击会替换计时器（按钮可重复使用）', clearTimeoutCalls > beforeSecond)
} catch (error) {
  check(`点击复制按钮未抛错（实际：${error?.message ?? error}）`, false)
}

// The OFF layout must render too — the panel used to re-center itself when the
// content shrank, which looked like a different screen.
try {
  const offSnapshot = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      loading: false,
      value: { ...STATUS_PAYLOAD, enabled: false, state: 'off', link: '', pairUrl: '', pairCode: '', hostname: '' },
      error: '',
    }),
  }
  const texts = []
  const collect = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      texts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) collect(item)
      return
    }
    if (typeof node !== 'object') return
    const { type, props } = node
    if (typeof type === 'function') {
      if (type.prototype && typeof type.prototype.render === 'function') {
        const instance = new type(props)
        instance.props = props
        collect(instance.render())
        return
      }
      collect(type(props))
      return
    }
    for (const child of Array.isArray(props?.children) ? props.children : [props?.children]) collect(child)
  }
  collect(react.createElement(main.component, { statusSnapshot: offSnapshot, onSetEnabled: () => {}, onPanelActive: () => {} }))
  check('关闭态渲染未抛错', true)
  check('关闭态显示占位说明', texts.some((text) => typeof text === 'string' && text.includes('打开开关后')))
} catch (error) {
  check(`关闭态渲染未抛错（实际：${error?.message ?? error}）`, false)
}

// A custom serve port must appear in the panel (and therefore in the QR/link the
// host hands us) — otherwise a non-443 setup looks broken.
try {
  const customSnapshot = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      loading: false,
      value: {
        ...STATUS_PAYLOAD,
        servePort: 8443,
        link: 'https://jiaxin-mbpm2.taila3698f.ts.net:8443/?token=T',
        pairUrl: 'https://jiaxin-mbpm2.taila3698f.ts.net:8443/tailscale-pair?c=ABCDEFGH',
      },
      error: '',
    }),
  }
  const texts = []
  const collectCustom = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      texts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) collectCustom(item)
      return
    }
    if (typeof node !== 'object') return
    const { type, props } = node
    if (typeof type === 'function') {
      if (type.prototype && typeof type.prototype.render === 'function') {
        const instance = new type(props)
        instance.props = props
        collectCustom(instance.render())
        return
      }
      collectCustom(type(props))
      return
    }
    for (const child of Array.isArray(props?.children) ? props.children : [props?.children]) collectCustom(child)
  }
  collectCustom(
    react.createElement(main.component, { statusSnapshot: customSnapshot, onSetEnabled: () => {}, onPanelActive: () => {} }),
  )
  check('自定义端口渲染未抛错', true)
  check(
    '自定义端口出现在界面文案里（:8443）',
    texts.some((text) => typeof text === 'string' && text.includes(':8443')),
  )
} catch (error) {
  check(`自定义端口渲染未抛错（实际：${error?.message ?? error}）`, false)
}

// Toggling the switch must not reject.
try {
  await injectProps.onSetEnabled?.(false)
  check('onSetEnabled(false) 未抛错', true)
} catch (error) {
  check(`onSetEnabled(false) 未抛错（实际：${error?.message ?? error}）`, false)
}

check('状态请求确实发出（fetch 被调用）', fetchCalls > 0)

// Stop the interval so the process can exit.
for (const cleanup of cleanups) {
  try {
    cleanup()
  } catch {
    /* ignore */
  }
}

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL（${failures.length} 项）`}`)
if (failures.length > 0) {
  for (const line of failures) console.log(`  · ${line}`)
  process.exitCode = 1
}
