# CC Switch AI Gateway

仓库同时包含独立的 [Cloudflare Worker 子项目](worker/README.md)：部署在 Cloudflare Workers，由调用方传入真实供应商 API Key。以下说明对应本机 CC Switch 局域网网关。

使用 TypeScript 和 `tsx` 运行的局域网 AI 网关。只读本机 CC Switch 的供应商配置，将 Claude / Codex 的原生 API 转发给局域网客户端。客户端无需真实 API Key；要求填写 Key 的客户端可以填 `12345678`。

HTTP 请求与响应正文、SSE 数据、WebSocket 帧不做协议转换。模型名称、工具参数、模型输出和供应商错误由上游决定。网关只处理路由、鉴权替换、连接管理以及 HTTP 代理必须调整的头部。

## 启动

需要 Node.js 22+、npm，以及本机 CC Switch 数据库。首次安装：

```sh
npm ci
cp .env.example .env
npm start
```

默认监听 `0.0.0.0:8787`。本机验收时的局域网地址为 `192.168.0.112`；换网络后使用这台电脑新的 IP。

也可以在 macOS / Linux 上后台运行：

```sh
npm run service:start
npm run service:status
npm run service:stop
```

后台进程用 Node.js 加载 `tsx` 执行同一个 TypeScript 入口。运行信息位于忽略提交的 `.runtime/` 中。后台启动不会安装开机启动服务。更改 `.env` 后需要重启；修改 CC Switch 当前供应商或同一供应商的凭据不需要重启。

## 另一台设备的 CC Switch 配置

| 客户端 | Base URL | Key | 协议 |
| --- | --- | --- | --- |
| Codex | `http://192.168.0.112:8787/codex/v1` | 留空；若必填则 `12345678` | Responses |
| Claude Code | `http://192.168.0.112:8787/claude` | 留空；若必填则 `12345678` | Anthropic Messages |

调用方发来的 `Authorization`、`x-api-key`、`x-goog-api-key` 和 Cookie 不会作为上游身份使用。网关用本机选定供应商的凭据重新设置鉴权。网关不校验调用方 Key，也不提供登录。

Codex 示例（不传 Key）：

```sh
curl http://192.168.0.112:8787/codex/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","input":"Reply with exactly OK.","stream":true}'
```

模型列表地址为 `/codex/v1/models` 或 `/claude/v1/models`。模型名称和客户端推理强度等参数由调用方指定，不会被网关替换成本机 CC Switch 的默认模型参数。

Codex 入口也可转发 `/codex/v1/chat/completions` 等接口，能否调用取决于供应商支持。此服务不把 Chat Completions、Responses、Messages 相互转换。

## 供应商选择

默认对两个入口分别跟随 CC Switch 数据库中 `is_current=1` 的供应商。每个新请求重新读取；正在进行的请求和 WebSocket 会话绑定开始时的供应商。

```sh
npm run providers
```

该命令仅列出客户端类型、供应商 ID、名称和当前状态，不读取供应商凭据。将供应商 ID 填入 `.env` 可以固定入口：

```dotenv
CODEX_PROVIDER=某个供应商ID
CLAUDE_PROVIDER=follow
```

固定模式不切换本机客户端供应商；同一 ID 的地址或 Key 更新后，新请求会使用新配置。供应商被删除、当前项缺失或重复时，网关明确报错，不暗中切换其他供应商。

支持的配置：Codex `auth.OPENAI_API_KEY`、供应商 `env_key` / `experimental_bearer_token`、`http_headers` / `env_http_headers`；Claude `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`。环境变量引用从网关进程环境解析。仅有 OAuth 登录凭据的配置不在首版范围，不能直接当作 API Key 转发。

路径拼接遵循各自客户端语义：Codex 的 `base_url` 是 API 根路径，网关将 `/codex/v1/responses` 的 `/responses` 追加到它后面；Claude 将 `/claude/v1/messages` 的 `/v1/messages` 追加到 `ANTHROPIC_BASE_URL` 后面。这样兼容 `/v1`、自定义路径以及 `/backend-api/codex` 等供应商地址。

## 配置项

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `CC_SWITCH_DIR` | `~/.cc-switch` | 只读数据库目录 |
| `CODEX_PROVIDER` | `follow` | 跟随或固定供应商 ID |
| `CLAUDE_PROVIDER` | `follow` | 跟随或固定供应商 ID |
| `UPSTREAM_PROXY` | `system` | `system`、`direct` 或 HTTP(S) 代理 URL |
| `UPSTREAM_HEADER_TIMEOUT_MS` | `120000` | 等待上游响应头的时限 |
| `SHUTDOWN_GRACE_MS` | `10000` | 关闭时等待连接结束的时限 |
| `LOG_LEVEL` | `info` | `silent` 关闭请求统计日志 |

`system` 优先使用进程的 HTTPS/HTTP 代理环境变量，否则在 macOS 读取系统 HTTPS 代理；其他平台没有代理环境变量时直连。SOCKS/PAC 不自动解析。代理设置启动时读取；当前机器的系统代理为 `http://127.0.0.1:7897`。

长响应在收到上游响应头后不设置空闲超时。客户端断开时取消上游；不自动重试生成，不自动故障转移。HTTP/SSE 支持流式背压；WebSocket 原样转发握手和双向数据。

`GET /health` 检查两个入口能否解析供应商，返回名称、模式与就绪状态。它不调用上游，也不代表供应商账号有余额、模型权限或实时可用。

## 隐私与日志

项目不复制真实 Key，不写入认证缓存，不打印配置内容、上游地址、请求查询参数、请求正文、响应正文或异常堆栈。请求日志仅包含事件、客户端类型、状态码和耗时。SQLite 以只读、仅查询方式打开。`.env`、日志和运行文件均被 Git 忽略。

## 验证

```sh
npm run check
```

包括供应商跟随/固定/凭据更新、非法配置脱敏、请求正文和头部、SSE 即时输出、压缩响应、上游错误、WebSocket 文本/二进制及拒绝握手、断连取消、超时、显式代理、优雅退出等测试。

在独立设备上验证模拟 Claude HTTP/SSE 和 WebSocket（无真实上游调用）：

```sh
LAN_SSH=my-mac LAN_HOST=192.168.0.112 \
  LAN_NODE=/Users/yy/.local/gmx-toolchains/node-v22.17.0/bin/node npm run check
```

真实 Codex API 验收，默认不测试 Claude：

```sh
ssh my-mac 'python3 - --base http://192.168.0.112:8787' < scripts/acceptance.py
```

真实 Codex CLI 验收使用远端临时 `CODEX_HOME` 和占位 Key，不修改远端现有配置：

```sh
ssh my-mac 'python3 - --base http://192.168.0.112:8787 --codex /Users/yy/.local/gmx-toolchains/bin/codex' \
  < scripts/acceptance-client.py
```

真实 WebSocket 生成检查（仅当上游支持）：

```sh
node scripts/acceptance-ws.mjs http://127.0.0.1:8787
```

所有验收脚本只打印状态、耗时和布尔检查结果。真实生成会使用供应商额度。

## 已验证范围与上游限制

2026-11-15 在 `ssh my-mac` 指向的局域网设备上验证了 SudoCode Fast / `gpt-6.1-sol`：模型列表无需 Key / 占位 Key、普通 Responses、SSE Responses，以及实际 Codex CLI 调用。

当前 SudoCode 的 Responses WebSocket 握手在直连、系统代理和本地网关访问时均返回 404，因此尚不能通过该上游完成真实 WebSocket 生成。网关的 WebSocket 能力通过本地及跨设备模拟上游验证。

按本次约定，Claude 不作为真实上游验收项。Claude 路由保留，并通过模拟上游验证 HTTP/SSE；账号权限开启后可显式使用 `scripts/acceptance.py --app claude` 验证。

## 未来整合 CC Switch

`src/types.ts` 定义 `ProviderResolver` 和跟随/固定选择方式；`src/cc-switch.ts` 是只读数据库适配器；`src/gateway.ts` 只依赖解析接口并提供 `start()` / `stop()` 生命周期；`src/index.ts` 负责独立进程启动。未来客户端可以传入自己的供应商解析器，或者管理独立服务进程，不需要让代理核心依赖桌面 UI 或数据库实现。
