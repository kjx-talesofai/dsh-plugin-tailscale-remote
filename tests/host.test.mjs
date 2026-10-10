/**
 * Host-half smoke test — loads the built host module with a stubbed cordis context
 * and a FAKE `tailscale` binary, so nothing on the real machine is touched.
 *
 * It covers the two gaps that both independent reviews called out:
 *  - **route level**: `/api/…status` auth (401/403), method handling (405),
 *    malformed JSON (400), and the pairing route (GET page / wrong code 403 /
 *    correct code 303 + token);
 *  - **runtime trust registration**: the plugin must extend the harness Host
 *    fence itself (`connection.trustedHosts`) and take its entry back on disable.
 *
 *   node tools/host-smoke.mjs
 */
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const DOMAIN = 'smoke-test-node.example.ts.net'
const failures = []
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`✅ ${label}`)
  } else {
    failures.push(label)
    console.log(`❌ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// ---- fake tailscale binary -------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), 'dsh-ts-smoke-'))
const stateFile = join(workDir, 'serve-state.json')
const fakeBin = join(workDir, 'tailscale')
process.env.FAKE_TS_STATE = stateFile
process.env.FAKE_TS_DOMAIN = DOMAIN
process.env.FAKE_TS_BACKEND = 'Running'

writeFileSync(
  fakeBin,
  `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const stateFile = process.env.FAKE_TS_STATE
const domain = process.env.FAKE_TS_DOMAIN
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return { port: null } } }
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s))
const status = () => JSON.stringify({
  BackendState: process.env.FAKE_TS_BACKEND || 'Running',
  CertDomains: [domain],
  Health: [],
  MagicDNSSuffix: domain.split('.').slice(1).join('.'),
  CurrentTailnet: { MagicDNSEnabled: true, MagicDNSSuffix: domain.split('.').slice(1).join('.') },
  Self: { DNSName: domain + '.', Online: true },
  Peer: { p1: { HostName: 'phone', Online: true, OS: 'android' } },
})
if (args[0] === 'status' && args[1] === '--json') { process.stdout.write(status()); process.exit(0) }
if (args[0] === 'serve') {
  if (args[1] === 'status') {
    const s = load()
    process.stdout.write(JSON.stringify(s.port === null ? {} : {
      Web: { [domain + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + s.port } } } },
    }))
    process.exit(0)
  }
  if (args[1] === 'off' || args.includes('off')) { save({ port: null }); process.exit(0) }
  const port = Number(args[args.length - 1])
  save({ port })
  process.exit(0)
}
process.stderr.write('fake tailscale: unexpected args ' + JSON.stringify(args))
process.exit(1)
`,
)
chmodSync(fakeBin, 0o755)
writeFileSync(stateFile, JSON.stringify({ port: null }))

// ---- a real listener for the self-check probe ------------------------------
// probeTrust() makes a real HTTP request to the harness port and expects 401
// (fence accepted the authority, no browser session yet).
let probeStatus = 401
const probeServer = createServer((_req, res) => {
  res.writeHead(probeStatus, { 'content-type': 'text/plain' })
  res.end('probe')
})
await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve))
const probePort = probeServer.address().port

// ---- stubbed cordis context ------------------------------------------------
const routes = new Map()
const taps = []
const cleanups = []
const connection = {
  trustedHosts: [],
  admit: () => ({ peer: {} }),
  authenticatedUrl: (base) => `${base}?token=FAKE-PROCESS-TOKEN`,
  isAuthenticated: () => false,
}
let enabledFlag = true
const liveConfig = {
  get enabled() {
    return { get: () => enabledFlag }
  },
}
const ctx = {
  connection,
  webServer: {
    port: probePort,
    host: '127.0.0.1',
    tapIndex: (transform) => {
      taps.push(transform)
      return () => {}
    },
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  settings: {
    update: async (_namespace, patch) => {
      if (typeof patch?.enabled === 'boolean') enabledFlag = patch.enabled
    },
  },
  effect: (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  },
  on: () => {},
  logger: () => ({ info: () => {}, warn: () => {} }),
}

function fakeRequest({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const chunks = body.length > 0 ? [Buffer.from(body)] : []
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.writeHead = (status, headers) => {
    res.statusCode = status
    res.headers = headers ?? {}
  }
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  }
  return res
}

const call = async (path, request) => {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const res = fakeResponse()
  await route.handler(request, res)
  // The pairing route is registered fire-and-forget (void pairHandler(...).catch),
  // so give the async handler a tick to actually write the response.
  await new Promise((resolve) => setTimeout(resolve, 40))
  return res
}

/** Poll until `condition()` is true (the plugin reconciles asynchronously). */
const waitFor = async (condition, timeoutMs = 12000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

const STATUS = '/api/tailscale-remote.status'
const SET = '/api/tailscale-remote.set'
const PAIR = '/tailscale-pair'

// ---- load the built host module -------------------------------------------
const module = await import(join(here, 'lib', 'index.js'))
const { injectTransportBootstrap } = module
check(
  'host 模块导出 apply/Config/classifyTailnet/RemoteError',
  ['apply', 'Config', 'classifyTailnet', 'RemoteError'].every((k) => k in module),
)
check(
  'RemoteError 把语言无关的 code 与 params 分开携带',
  (() => {
    const failure = new module.RemoteError('demo.code', { value: 'x' }, '中文说明 x')
    return failure.code === 'demo.code' && failure.params.value === 'x' && failure.message === '中文说明 x'
  })(),
)

module.apply(ctx, {
  // volatile fields arrive as live references (config.get()); model that faithfully
  get enabled() {
    return { get: () => enabledFlag }
  },
  get hostname() {
    return { get: () => '' }
  },
  tailscaleBin: fakeBin,
  servePort: 443,
  pairing: true,
  debug: false,
})
check('注册了 status 路由', routes.has(STATUS))
check('注册了 set 路由', routes.has(SET))
check('注册了配对路由', routes.has(PAIR))
check('debug 关闭时未注册诊断/回显路由', !routes.has('/api/tailscale-remote.diag') && !routes.has('/tailscale-probe'))

// ---- remote transport bootstrap (host-backed settings on the phone) ---------
check('注册了 webServer index-tap', taps.length === 1)
const sampleHtml = '<html><head><meta charset="utf-8"></head><body><script>window.__DSH_BOOT__={}</script></body></html>'
const tapped = taps[0](sampleHtml)
check('首页被注入 transport 引导脚本', tapped.includes('__DSH_TRANSPORT__'))
check(
  '引导脚本在 __DSH_BOOT__ 之前执行',
  tapped.indexOf('__DSH_TRANSPORT__') < tapped.indexOf('__DSH_BOOT__'),
)
check('引导脚本不覆盖 shell 已提供的 transport（有 guard）', tapped.includes('if(g.__DSH_TRANSPORT__)return;'))
check('ownsHost 被声明为 true', /ownsHost:true/.test(tapped))
check('无 <head> 的 HTML 原样返回', injectTransportBootstrap('<html></html>') === '<html></html>')

// The plugin reconciles on boot after a short delay; wait for the observable effect
// (its runtime trust registration) rather than guessing a duration.
const registered = await waitFor(() => connection.trustedHosts.includes(DOMAIN))
check('运行期把自己注册进 harness 信任栅栏（等待 boot reconcile）', registered, `trustedHosts=${JSON.stringify(connection.trustedHosts)}`)
await waitFor(async () => {
  const probe = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
  try {
    return JSON.parse(probe.body).state === 'on'
  } catch {
    return false
  }
})

// ---- route level: status ---------------------------------------------------
let res = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
check('status（已放行）→ 200', res.statusCode === 200, `got ${res.statusCode}`)
let payload = {}
try {
  payload = JSON.parse(res.body)
} catch {
  /* reported below */
}
check('status 载荷：state=on', payload.state === 'on', `state=${payload.state}`)
check('status 载荷：servePort=443', payload.servePort === 443)
check('status 载荷：tailnet.fence=added（运行期注入）', payload.tailnet?.fence === 'added', JSON.stringify(payload.tailnet))
check('status 载荷：带 token 链接', typeof payload.link === 'string' && payload.link.includes('token='))
check('status 载荷：一次性配对码存在', typeof payload.pairCode === 'string' && payload.pairCode.length > 0)
check('status 载荷：detailCode/detailParams/sessionOnly 形状稳定', payload.detailCode === '' && typeof payload.detailParams === 'object' && payload.sessionOnly === false)

connection.admit = () => ({ rejection: 401 })
res = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
check('status（session 缺失）→ 401', res.statusCode === 401, `got ${res.statusCode}`)

connection.admit = () => ({ rejection: 403 })
res = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
check('status（栅栏拒绝）→ 403', res.statusCode === 403, `got ${res.statusCode}`)

connection.admit = () => { throw new Error('broken contract') }
res = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
check('admit 抛错时 fail-closed → 503', res.statusCode === 503, `got ${res.statusCode}`)

connection.admit = () => ({ peer: {} })
res = await call(STATUS, fakeRequest({ method: 'POST', url: STATUS, headers: { host: '127.0.0.1:19387' } }))
check('status 非 GET → 405', res.statusCode === 405, `got ${res.statusCode}`)

// ---- route level: set ------------------------------------------------------
res = await call(SET, fakeRequest({ method: 'GET', url: SET, headers: { host: '127.0.0.1:19387' } }))
check('set 非 POST → 405', res.statusCode === 405, `got ${res.statusCode}`)

res = await call(
  SET,
  fakeRequest({
    method: 'POST',
    url: SET,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: '{not json',
  }),
)
check('set 非法 JSON → 400', res.statusCode === 400, `got ${res.statusCode}`)

res = await call(
  SET,
  fakeRequest({
    method: 'POST',
    url: SET,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: 'null',
  }),
)
check('set body=null → 400（不是 500）', res.statusCode === 400, `got ${res.statusCode}`)

res = await call(
  SET,
  fakeRequest({
    method: 'POST',
    url: SET,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  }),
)
check('set {"enabled":false} → 200', res.statusCode === 200, `got ${res.statusCode}`)
const revoked = await waitFor(() => !connection.trustedHosts.includes(DOMAIN))
check(
  '关闭后撤销了运行期注入的信任条目',
  revoked,
  `trustedHosts=${JSON.stringify(connection.trustedHosts)}`,
)

// ---- route level: pairing --------------------------------------------------
res = await call(PAIR, fakeRequest({ url: `${PAIR}?c=BADCODE` }))
check('配对页 GET（任意码）→ 200，不泄露码是否存在', res.statusCode === 200, `got ${res.statusCode}`)

// The pairing page is served before any client bundle loads, so it cannot use the
// locale service. It follows the phone's own `Accept-Language` instead.
res = await call(PAIR, fakeRequest({ url: `${PAIR}?c=BADCODE`, headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } }))
check(
  '配对页（Accept-Language: zh-CN）→ 中文',
  res.body.includes('lang="zh-CN"') && res.body.includes('进入 DeepSeek Harness'),
  'no zh page',
)
res = await call(PAIR, fakeRequest({ url: `${PAIR}?c=BADCODE`, headers: { 'accept-language': 'en-US,en;q=0.9' } }))
check(
  '配对页（Accept-Language: en-US）→ 英文',
  res.body.includes('lang="en"') && res.body.includes('Enter DeepSeek Harness'),
  'no en page',
)
res = await call(PAIR, fakeRequest({ url: `${PAIR}?c=BADCODE` }))
check(
  '配对页（无 Accept-Language）→ 英文兜底',
  res.body.includes('lang="en"') && !/[\u4e00-\u9fff]/.test(res.body),
  'expected an all-English page',
)
check('配对页仍把码带进表单', res.body.includes('value="BADCODE"'))

res = await call(
  PAIR,
  fakeRequest({
    method: 'POST',
    url: PAIR,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'c=BADCODE',
  }),
)
check('配对 POST 错码 → 403', res.statusCode === 403, `got ${res.statusCode}`)

res = await call(
  PAIR,
  fakeRequest({
    method: 'POST',
    url: PAIR,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
    body: `c=${payload.pairCode ?? ''}`,
  }),
)
check('配对 POST 跨站 → 403（同站校验）', res.statusCode === 403, `got ${res.statusCode}`)

// Re-enable so a fresh code exists, then redeem it in the same-site shape.
await call(
  SET,
  fakeRequest({
    method: 'POST',
    url: SET,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }),
)
await waitFor(async () => {
  const probe = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
  try {
    return JSON.parse(probe.body).state === 'on'
  } catch {
    return false
  }
})
res = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
const liveCode = JSON.parse(res.body).pairCode
res = await call(
  PAIR,
  fakeRequest({
    method: 'POST',
    url: PAIR,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `c=${liveCode}`,
  }),
)
check('配对 POST 正确码 → 303', res.statusCode === 303, `got ${res.statusCode}`)
check(
  '配对 303 的 Location 带进程 token',
  typeof res.headers.location === 'string' && res.headers.location.includes('token='),
  String(res.headers.location),
)

// ---- host failures carry a language-neutral code ---------------------------
// The panel localizes `detailCode`; the Chinese `detail` stays as the fallback
// for a client that does not know the code yet.
process.env.FAKE_TS_BACKEND = 'Stopped'
await call(
  SET,
  fakeRequest({
    method: 'POST',
    url: SET,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  }),
)
await call(
  SET,
  fakeRequest({
    method: 'POST',
    url: SET,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }),
)
const failedReconcile = await waitFor(async () => {
  const probe = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
  try {
    return JSON.parse(probe.body).state === 'error'
  } catch {
    return false
  }
})
check('Tailscale 未运行 → state=error', failedReconcile)
res = await call(STATUS, fakeRequest({ url: STATUS, headers: { host: '127.0.0.1:19387' } }))
const failure = JSON.parse(res.body)
check('失败载荷带语言无关的 detailCode', failure.detailCode === 'tailnet.stopped', `detailCode=${failure.detailCode}`)
check('detailParams 保持对象形状', typeof failure.detailParams === 'object' && failure.detailParams !== null)
check('失败时同时保留中文 detail（旧客户端/curl 的兜底）', typeof failure.detail === 'string' && failure.detail.length > 0)
check('失败时清空链接与配对码', failure.link === '' && failure.pairCode === '' && failure.pairUrl === '')
process.env.FAKE_TS_BACKEND = 'Running'

// ---- cleanup ---------------------------------------------------------------
for (const cleanup of cleanups) {
  try {
    cleanup()
  } catch {
    /* ignore */
  }
}
await new Promise((resolve) => probeServer.close(resolve))
rmSync(workDir, { recursive: true, force: true })

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL（${failures.length} 项）`}`)
if (failures.length > 0) {
  for (const line of failures) console.log(`  · ${line}`)
  process.exitCode = 1
}
