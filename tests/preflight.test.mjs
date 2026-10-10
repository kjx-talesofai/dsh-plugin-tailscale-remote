/**
 * Unit tests for `classifyTailnet` — the preflight decision table.
 *
 * These are the first automated tests in this project (both independent reviews
 * flagged their absence). They run against the REAL source module, so the rules
 * cannot drift away from what the plugin executes.
 *
 *   node tools/preflight-test.mjs
 *
 * Exit code 0 = all cases behaved as specified.
 */
import { classifyTailnet } from '../src/index.js'

const DOMAIN = 'jiaxin-mbpm2.taila3698f.ts.net'

/** A payload shaped like the live `tailscale status --json` on this machine. */
const healthy = () => ({
  BackendState: 'Running',
  CertDomains: [DOMAIN],
  Health: [],
  MagicDNSSuffix: 'taila3698f.ts.net',
  CurrentTailnet: { MagicDNSEnabled: true, MagicDNSSuffix: 'taila3698f.ts.net' },
  Self: { DNSName: `${DOMAIN}.`, Online: true },
  Peer: {
    a: { HostName: 'phone', Online: true, OS: 'android' },
    b: { HostName: 'laptop', Online: false, OS: 'macOS' },
  },
})

const cases = [
  {
    name: '健康环境 → 通过，并给出域名与对端统计',
    status: healthy(),
    expect: { ok: true, hostname: DOMAIN, backend: 'Running', peersOnline: 1, peersTotal: 2 },
  },
  {
    name: 'BackendState=NeedsLogin → 提示登录',
    status: { ...healthy(), BackendState: 'NeedsLogin' },
    expect: { ok: false, match: /需要登录 Tailscale/, code: 'tailnet.needsLogin' },
  },
  {
    name: 'BackendState=Stopped → 提示打开客户端',
    status: { ...healthy(), BackendState: 'Stopped' },
    expect: { ok: false, match: /未运行：请打开 Tailscale 客户端/, code: 'tailnet.stopped' },
  },
  {
    name: 'BackendState=NoState（未知）→ 归入 tailnet.unavailable 并带上原始值',
    status: { ...healthy(), BackendState: 'NoState' },
    expect: { ok: false, match: /BackendState=NoState/, code: 'tailnet.unavailable' },
  },
  {
    name: '未开启 HTTPS Certificates（CertDomains 不含本机域名）→ 明确提示',
    status: { ...healthy(), CertDomains: [] },
    expect: { ok: false, match: /HTTPS Certificates/, code: 'tailnet.noCertificate' },
  },
  {
    name: 'MagicDNS 关闭 → 明确提示（否则域名不解析）',
    status: { ...healthy(), CurrentTailnet: { MagicDNSEnabled: false } },
    expect: { ok: false, match: /MagicDNS/, code: 'tailnet.magicDns' },
  },
  {
    name: 'Self.DNSName 为空 → 明确提示',
    status: { ...healthy(), Self: { DNSName: '' } },
    expect: { ok: false, match: /未返回本机域名/, code: 'tailnet.noDomain' },
  },
  {
    name: 'Health 有告警 → 仍通过，但把告警带出来（不致命）',
    status: { ...healthy(), Health: ['Tailscale is not connected to a DERP relay'] },
    expect: { ok: true, health: ['Tailscale is not connected to a DERP relay'] },
  },
  {
    name: 'hostname 覆盖非法（带协议/端口/路径）→ 拒绝',
    status: healthy(),
    options: { override: 'https://evil.example.com/' },
    expect: { ok: false, match: /hostname 配置不合法/, code: 'hostname.invalid' },
  },
  {
    name: 'hostname 覆盖合法且与证书匹配 → 采用覆盖值',
    status: healthy(),
    options: { override: DOMAIN },
    expect: { ok: true, hostname: DOMAIN },
  },
  {
    name: '域名含下划线（非法 authority）→ 拒绝',
    status: { ...healthy(), Self: { DNSName: 'bad_host.taila3698f.ts.net.' } },
    expect: { ok: false, match: /hostname 配置不合法|tailnet 域名不合法/, code: 'tailnet.badDomain' },
  },
]

let passed = 0
const failures = []
for (const testCase of cases) {
  let outcome
  try {
    outcome = { ok: true, value: classifyTailnet(testCase.status, testCase.options ?? { bin: 'tailscale' }) }
  } catch (error) {
    // `code` is what the browser half translates; `message` is the Chinese fallback.
    outcome = { ok: false, message: String(error?.message ?? error), code: error?.code }
  }

  const expected = testCase.expect
  let ok = outcome.ok === expected.ok
  if (ok && expected.ok === false) ok = expected.match.test(outcome.message)
  if (ok && expected.code !== undefined) ok = outcome.code === expected.code
  if (ok && expected.ok === true) {
    for (const [key, value] of Object.entries(expected)) {
      if (key === 'ok') continue
      const actual = outcome.value?.[key]
      if (JSON.stringify(actual) !== JSON.stringify(value)) {
        ok = false
        failures.push(`${testCase.name} → ${key} 期望 ${JSON.stringify(value)}，实得 ${JSON.stringify(actual)}`)
      }
    }
  }
  if (!ok && failures.every((line) => !line.startsWith(testCase.name))) {
    failures.push(`${testCase.name} → 期望 ok=${String(expected.ok)}${expected.match ? ` 且匹配 ${expected.match}` : ''}${expected.code ? ` 且 code=${expected.code}` : ''}，实得 ${JSON.stringify(outcome)}`)
  }
  if (ok) passed += 1
  console.log(`${ok ? '✅' : '❌'} ${testCase.name}`)
}

console.log(`\n${passed}/${cases.length} 通过`)
if (failures.length > 0) {
  console.log('\n失败详情：')
  for (const line of failures) console.log(`  · ${line}`)
  process.exitCode = 1
}
