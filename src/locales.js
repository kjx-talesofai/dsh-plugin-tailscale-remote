/**
 * Bilingual copy for the browser half, registered as one namespace dictionary
 * with the harness's `locale` service (`@deepseek-ai/dsh-client-locale`).
 *
 * Both shipped locales are required: the service refuses a namespace that does
 * not cover every language it can activate. Lookup walks the active language's
 * fallback chain and ends at `en`, so a language pack added later (e.g. `ja`
 * falling back to `en`) picks these strings up without a change here.
 *
 * `detail.*` mirrors the host's stable failure codes one-for-one
 * (`detailCode` in the status payload): the host never guesses the reader's
 * language, the client never guesses what went wrong.
 *
 * @module dsh-plugin-tailscale-remote/locales
 */

/** Namespace this plugin owns; also the `locale` field of both slot registrations. */
export const NS = 'tailscale-remote'

/** Simplified Chinese copy. */
export const zh = {
  'panel.title': 'Tailscale 远程访问',
  'panel.helpLabel': '说明',
  'switch.label': '启用 Tailscale 远程访问',
  'state.on': '已开启',
  'state.pending': '正在启用…',
  'state.error': '出错',
  'state.syncing': '已打开，等待同步…',
  'state.off': '已关闭',
  'hint.enable': '打开开关后，这里会出现二维码：手机扫码 → 在打开的页面点一下即可进入。',
  'qr.scan': '手机扫码，',
  'qr.enter': '在打开的页面点一下「进入 DSH」',
  'qr.failed': '二维码生成失败，请刷新面板重试。',
  'copy.copy': '复制',
  'copy.copied': '已复制',
  'render.failed': 'Tailscale 面板渲染失败：{message}',
  'help.1': '前提：手机与 Mac 在同一个 Tailscale 网络（tailnet），手机上 Tailscale 保持在线。',
  'help.2': '用手机相机扫上面的二维码，在打开的页面点一下「进入 DSH」。',
  'help.3': '之后这个浏览器直接访问 https://{host}/ 即可，不必再扫码。',
  'help.4': '关掉开关只撤销这个入口；已登录的设备 30 天内仍有效，重启本程序会换新 token。',
  'error.auth': '需要登录会话（请从带 token 的链接打开）',
  'error.http': 'HTTP {status}',
  'error.network': '请求失败：{message}',
  'error.toggleHttp': '切换失败：HTTP {status}',
  'detail.sessionOnly': '（本次会话生效，未持久化）',

  // Host failure codes — see `RemoteError` in src/index.js.
  'detail.hostname.invalid': 'hostname 配置不合法（只允许纯主机名，不含端口/协议/路径）：{value}',
  'detail.tailnet.needsLogin': 'Tailscale 需要登录：请打开 Tailscale 客户端完成登录',
  'detail.tailnet.stopped': 'Tailscale 未运行：请打开 Tailscale 客户端并连接',
  'detail.tailnet.starting': 'Tailscale 正在启动：请稍后重试',
  'detail.tailnet.unavailable': 'Tailscale 不可用（BackendState={backend}）：请检查 Tailscale 客户端',
  'detail.tailnet.noDomain': 'Tailscale 已运行但未返回本机域名（Self.DNSName 为空）',
  'detail.tailnet.badDomain': 'tailnet 域名不合法：{value}',
  'detail.tailnet.magicDns': 'tailnet 未启用 MagicDNS：域名无法解析，请在 Tailscale 管理台开启 MagicDNS',
  'detail.tailnet.noCertificate':
    '未找到 {hostname} 的 HTTPS 证书：请在 Tailscale 管理台开启 HTTPS Certificates 后重试',
  'detail.bin.missing':
    '找不到 tailscale 可执行文件（tailscaleBin={bin}）：请安装 Tailscale 客户端，或把 tailscaleBin 配成绝对路径',
  'detail.tailscale.statusRead': '无法读取 Tailscale 状态：{message}',
  'detail.webserver.unbound': 'web server 未在超时内绑定端口',
  'detail.serve.portBusy':
    '端口 {port} 已被另一条 serve 映射占用（→ {occupant}）：已放弃覆盖。请改 servePort，或先移除该映射。',
  'detail.fence.refused':
    '域名未通过信任栅栏（403）：{url} 。本插件已把自己写进 trustedHosts 却仍被拒绝——请重启 DSH 后重试。',
  'detail.fence.selfCheck': '自检未通过（HTTP {code}）：无法确认 /api 是否接受该 authority。',
}

/** English copy. Required: it is the terminal fallback for every other language. */
export const en = {
  'panel.title': 'Tailscale Remote Access',
  'panel.helpLabel': 'How it works',
  'switch.label': 'Enable Tailscale remote access',
  'state.on': 'On',
  'state.pending': 'Enabling…',
  'state.error': 'Error',
  'state.syncing': 'On, waiting for sync…',
  'state.off': 'Off',
  'hint.enable':
    'Turn the switch on and a QR code appears here: scan it with your phone, then tap once on the page it opens.',
  'qr.scan': 'Scan with your phone,',
  'qr.enter': 'then tap “Enter DSH” on the page it opens',
  'qr.failed': 'Could not build the QR code. Refresh the panel and try again.',
  'copy.copy': 'Copy',
  'copy.copied': 'Copied',
  'render.failed': 'The Tailscale panel failed to render: {message}',
  'help.1':
    'First: your phone and this Mac must be on the same Tailscale network (tailnet), with Tailscale online on the phone.',
  'help.2': 'Scan the QR code above with your phone camera, then tap “Enter DSH” on the page it opens.',
  'help.3': 'After that this browser can go straight to https://{host}/ — no more scanning.',
  'help.4':
    'Turning the switch off only removes this entry point; a device already signed in stays valid for 30 days, and restarting this app issues a new token.',
  'error.auth': 'A signed-in session is required (open the link that carries the token).',
  'error.http': 'HTTP {status}',
  'error.network': 'Request failed: {message}',
  'error.toggleHttp': 'Could not toggle: HTTP {status}',
  'detail.sessionOnly': ' (applies to this session only; not saved)',

  // Host failure codes — see `RemoteError` in src/index.js.
  'detail.hostname.invalid':
    'Invalid hostname configuration (a bare hostname only — no port, scheme, or path): {value}',
  'detail.tailnet.needsLogin': 'Tailscale needs a login: open the Tailscale client and sign in',
  'detail.tailnet.stopped': 'Tailscale is not running: open the Tailscale client and connect',
  'detail.tailnet.starting': 'Tailscale is starting: try again in a moment',
  'detail.tailnet.unavailable':
    'Tailscale is unavailable (BackendState={backend}): check the Tailscale client',
  'detail.tailnet.noDomain': 'Tailscale is running but returned no device domain (Self.DNSName is empty)',
  'detail.tailnet.badDomain': 'Invalid tailnet domain: {value}',
  'detail.tailnet.magicDns':
    'MagicDNS is not enabled for this tailnet: the domain will not resolve. Enable MagicDNS in the Tailscale admin console.',
  'detail.tailnet.noCertificate':
    'No HTTPS certificate for {hostname}: enable HTTPS Certificates in the Tailscale admin console, then retry',
  'detail.bin.missing':
    'Cannot find the tailscale executable (tailscaleBin={bin}): install the Tailscale client, or point tailscaleBin at an absolute path',
  'detail.tailscale.statusRead': 'Cannot read Tailscale status: {message}',
  'detail.webserver.unbound': 'The harness web server did not bind a port in time',
  'detail.serve.portBusy':
    'Port {port} is already served by another mapping (→ {occupant}); refusing to overwrite it. Change servePort, or remove that mapping first.',
  'detail.fence.refused':
    'The trust fence refused this authority (403): {url}. This plugin already added itself to trustedHosts and was still refused — restart DSH and try again.',
  'detail.fence.selfCheck':
    'The self-check failed (HTTP {code}): cannot confirm /api accepts this authority.',
}

/** Every key the two shipped dictionaries must agree on (asserted by the tests). */
export const KEYS = Object.freeze(Object.keys(zh))

/** Substitute `{name}` placeholders; an unknown name is left visible rather than blanked. */
export function translate(dictionary, key, params) {
  const template = dictionary[key] ?? key
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  )
}

/**
 * Copy used when no framework locale seat reached the component — a unit render,
 * or a composition whose renderer predates the seat. English, never a raw key.
 */
export const fallbackT = (key, params) => translate(en, key, params)
