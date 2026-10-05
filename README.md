<p align="center">
  <img src="assets/icon.svg" alt="dsh-plugin-tailscale-remote" height="112"/>
</p>

# dsh-plugin-tailscale-remote

Open your **DeepSeek Harness desktop Web UI** from your phone over **your own Tailscale tailnet**. One switch creates a tailnet-only HTTPS mapping, shows a QR code, and the phone is in — no port forwarding, no reverse proxy, no public exposure.

> dsh-plugin-tailscale-remote — 一个开关，把桌面端的 DSH 从你自己的手机打开

<details>
<summary><b>中文说明（点开）</b> —— 用 Tailscale 把桌面端 DSH 开到手机上，只在你自己的网络里</summary>

**它是什么**：DSH 桌面端插件。打开侧栏里的「Tailscale 远程访问」开关，它就为你在 tailnet 上建一条 HTTPS 映射（`https://<你的设备名>.<你的 tailnet>.ts.net/` → 本机 `127.0.0.1:<DSH 端口>`），面板给出配对二维码；手机扫码、点一下「进入 DSH」，就进去了。之后这台手机直接访问那个域名即可。

**为什么做**：DSH 的 Web UI 只监听回环地址（`127.0.0.1`），这是对的——但它意味着手机天然连不上。Tailscale 已经把两台设备放进同一张虚拟网，缺的只是把 GUI 安全地桥过去：不开放公网、不做端口转发、服务端也不用改成监听 `0.0.0.0`。这个插件就是那座桥，加上一个开关、一个二维码和状态灯。

**和 [DeepSeek Harness Mobile](https://github.com/search?q=deepseek+harness+mobile) 的分工**：那是社区自研的**安卓客户端**——想给手机一个原生 App 的人应该用那个，体验是专门为手机做的。这个插件走的是相反的、也故意更窄的路：**手机侧不装任何东西**（就是一个浏览器标签页），不用注册账号、不经过任何中继，也不引入另一套会话管理；代价是**必须有一台开着的、能跑 DSH 的桌面机**，且它与手机在同一个 tailnet 里。它不是客户端，只是一座接入现有桌面实例的桥。

**怎么装**（三种任选，在 DSH「添加插件」里填）：

| 填入 | 形式 |
|---|---|
| npm 包名 | `dsh-plugin-tailscale-remote`（可加 `@0.2.0` 锁版本） |
| GitHub | `github:kjx-talesofai/dsh-plugin-tailscale-remote#v0.2.0` |
| 本地目录 | 绝对路径，例如 `/path/to/dsh-plugin-tailscale-remote` |

装完**重启桌面端**（host 半边只在启动时加载）。没有别的步骤：hostname 由插件启动时自己探测并注册进 harness 的信任栅栏。

**怎么用**：侧栏「Tailscale 远程访问」→ 打开开关 → 手机相机扫二维码 → 在打开的页面点一下「进入 DSH」。此后这台手机直接开 `https://<域名>/` 即可（会话 cookie 保留 30 天）。开关关掉 = 撤销那条映射。

**Tailscale 组网（三步，别人的 agent 照着做就行）**：

1. Mac 与手机都安装 Tailscale 客户端，用**同一个账号**登录（同一 tailnet）；
2. 打开 [Tailscale 管理台](https://login.tailscale.com/admin/dns) 的 DNS 页，启用 **MagicDNS** 与 **HTTPS Certificates**；
3. 验证：`tailscale status` 能看到两台设备，`tailscale ip -4` 给出 `100.x` 地址。

插件会在打开开关时预检这三项（含证书是否已签发），缺哪一项都会在面板上用红字说清楚，不会出现"绿灯但连不上"。**这也是本插件唯一的前置依赖**——它不含、也不能替代组网本身。

**注意事项**：

- 只用 Serve，**绝不用 Funnel**：映射只在 tailnet 内可达，不暴露到公网；
- DSH 始终只监听 `127.0.0.1`，插件不会改它的绑定；
- **撤销传输 ≠ 撤销会话**：关开关只撤销入口，手机已签发的会话 cookie 在 30 天内仍有效；
- Mac 睡眠/合盖时隧道断开，手机就连不上；Tailscale 客户端必须保持运行；
- 配对码一次性、10 分钟有效，用过会自动换新。

**卸载**：DSH「插件」列表里卸载 `dsh-plugin-tailscale-remote` → 重启。想连入口一起清掉，先在面板里关掉开关（它会撤销自己建立的那条 `tailscale serve` 映射）。

**老实说（实测范围）**：只在 **macOS（Apple Silicon）+ DSH 0.2.0-rc.2 + Tailscale CLI 1.102.4** 上端到端跑过（真实手机扫码登录成功）。Windows / Linux 未测；DSH 升级后上游契约可能变化，见下方 Compatibility。

</details>

## Why

DSH's Web UI binds to loopback only, which is the right default — and it means your phone cannot reach it, ever. Tailscale already puts your devices on one virtual network, so the missing piece is small and specific: bridge that one loopback port to a **tailnet-only HTTPS origin with a real certificate**, and make it a switch you can turn off.

That is all this plugin is. It is intentionally narrow:

- **No new listener, no `0.0.0.0`.** The harness keeps binding loopback; `tailscale serve` terminates TLS and proxies to it.
- **No account, no relay, no telemetry.** Traffic stays inside your tailnet (WireGuard). The plugin never sends anything anywhere.
- **No persistent token.** The launch link carries a per-process token that is never written to disk; the panel shows it only inside the authenticated UI.

### How this relates to a native client

A community-built Android app, **DeepSeek Harness Mobile**, exists for people who want a real client on the phone: it is a purpose-built app with its own lifecycle and session handling, and if a native phone experience is what you are after, use that.

This plugin deliberately takes the other trade. Nothing is installed on the phone beyond a browser tab, there is no account, no relay, and no second session store — but it only works while a desktop running DSH is awake and on the same tailnet. It is not a client; it is a thin bridge into the instance you already run.

## Install

Use DSH's plugin install dialog (**Add plugin**) with any of these, then restart the desktop app:

```text
dsh-plugin-tailscale-remote                              # npm registry (recommended)
github:kjx-talesofai/dsh-plugin-tailscale-remote#v0.2.0   # pinned GitHub release
/absolute/path/to/dsh-plugin-tailscale-remote             # local checkout (dev)
```

CLI equivalent:

```sh
dsh plugin --profile desktop add dsh-plugin-tailscale-remote
```

Anything machine-specific is discovered at runtime. If you prefer a **declarative** entry instead (a managed block in your profile's `cordis.patch.yml`), the package ships the installer:

```sh
node ~/.dsh/profiles/desktop/node_modules/dsh-plugin-tailscale-remote/scripts/install.mjs --profile desktop
```

Requires **DSH Desktop ≥ 0.2.0-rc.1** and **Tailscale** on both devices (see below).

## Tailscale, in three steps

For you — or for an agent configuring this on another machine:

1. **Join one tailnet.** Install Tailscale on the desktop and the phone, sign in to the *same* account.
2. **Turn on two switches** in the [admin DNS page](https://login.tailscale.com/admin/dns): **MagicDNS** and **HTTPS Certificates**.
3. **Verify:** `tailscale status` lists both devices; `tailscale ip -4` prints a `100.x` address.

The plugin's preflight checks exactly these three things (including whether a certificate for your node name has actually been issued) and reports the missing one in plain language. It does not set them up for you — networking stays Tailscale's job.

## Usage

1. Sidebar → **Tailscale 远程访问** → turn the switch on. The panel shows status, one QR code, and the fallback link.
2. Phone camera → scan → the pairing page opens → tap **进入 DSH**.
3. That browser now has a session (30 days). Open `https://<node>.<tailnet>.ts.net/` directly from then on.

Turn the switch off to remove the mapping. On a custom `servePort` the URL carries the port (`https://<node>.<tailnet>.ts.net:8443/`); the panel shows it too.

### How it works

```
phone ──HTTPS──▶ Tailscale Serve ──▶ 127.0.0.1:<DSH port>   (harness Web UI)
        tailnet-only + real cert      loopback only, unchanged
   ▲                                        ▲
   └── pairing page hands the session cookie │ plugin registers the tailnet
       to the browser from a same-site page  │ authority with the /api trust fence
```

| | |
|---|---|
| Mapping | `tailscale serve --bg --https=<servePort> <local port>` |
| Fence | the plugin registers its own tailnet authority at runtime (no profile edit needed) |
| Pairing | one-time code (10 min, single use, same-site + rate-limited), because Chromium refuses to store a `SameSite=Strict` cookie set during an app-initiated redirect |
| Diagnostics | `debug: true` in the plugin config registers an opt-in diag route and a marker-gated scan-path echo |

## Security

- **tailnet-only.** `tailscale serve`, never `tailscale funnel`.
- **loopback host.** The harness keeps listening on `127.0.0.1`; the plugin never rebinds it.
- **Token not persisted.** The per-process launch token lives in memory and is shown only through the authenticated panel; the saved session cookie is what survives.
- **Fenced routes.** `/api/tailscale-remote.*` reuse the harness's own Host/Origin fence plus its session gate; when that gate is unavailable the plugin fails **closed** (503).
- **Reversible transport.** Turning the switch off removes the mapping the plugin created — and only that one (`tailscale serve` is machine-global, so a foreign mapping is left alone).
- **Not reversible: the session.** Revoking the transport does not revoke an issued cookie; rotate `client-connection/browser-session` in `~/.dsh/.credentials.yaml` if you need that.

## Compatibility

Verified end-to-end on **macOS (Apple Silicon) · DSH Desktop 0.2.0-rc.2 · Tailscale 1.102.4**, with a real phone on the same tailnet. Platform modules in the app bundle: `dsh-client-connection`, `dsh-client-ui-primitives`, `dsh-host-frontend-static` at `0.2.0-rc.2`; `@deepseek-ai/cordis` `4.0.4`; `@deepseek-ai/schemastery` `3.18.4`.

Not tested: Windows, Linux, and DSH versions other than 0.2.0-rc.2. The plugin leans on upstream behaviour (the `/api` trust fence, volatile plugin config, the client slot contract, `tailscale serve status --json`); the test suites below pin what it depends on, so run `npm test` first after a DSH upgrade.

## Development

```sh
npm install          # esbuild + runtime deps
npm run build        # src/ → lib/   (the client half is inlined into the harness's lazy-CJS wrapper)
npm test             # 3 suites: preflight decision table · client render/lifecycle · host routes + fence
```

Repo layout — **sources vs artifacts**:

| Path | What it is | Ships to users |
|---|---|---|
| `src/index.js` | host half (source) | ✗ (`lib/` is the build output) |
| `src/client.jsx` | browser half (source) | ✗ |
| `lib/index.js`, `lib/client.js` | built artifacts, committed so `github:` installs work without a build step | ✓ |
| `cordis.patch.yml` | bundle layer: inserts this plugin's row | ✓ |
| `assets/icon.svg` | plugin icon shown in DSH's plugin manager | ✓ |
| `scripts/build.mjs` | build (esbuild wrapper + contract checks) | ✗ |
| `scripts/install.mjs` | optional declarative installer (profile patch) | ✓ |
| `tests/*.test.mjs` | preflight table · client smoke (real bundle in a stub DOM) · host smoke (stub cordis + fake `tailscale`) | ✗ |
| `dist/` | `npm pack` output (git-ignored) | ✗ |

## Uninstall

Remove the plugin in DSH's plugin list and restart. Before that, turn the switch **off** in the panel so the `tailscale serve` mapping is revoked.

## License

[MIT](LICENSE) © 2026 Jiaxin Kou

<p align="center">
  <a href="https://hypersampling.com">
    <img src="https://assets.hypersampling.com/hyper-sampling-2.jpg" alt="hypersampling" height="38"/>
  </a>
</p>

Built by [Jiaxin Kou](https://hypersampling.com) · [GitHub](https://github.com/kjx-talesofai)
