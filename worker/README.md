# AI Gateway Worker

当前推荐的 Codex Base URL 为 **`https://doc.jimao.uk/summary-20261121`**（`doc` 为单数）。直接填写这个完整前缀，不追加 `/v1` 或 `/codex`；Codex 会追加 `/responses`、`/models` 等接口路径。使用现有通用密钥或匹配上游的真实 Key。旧的 `https://docs.jimao.uk/codex/v1` 保留兼容。两个域名根路径都提供博客页面。

新入口复测（在仓库根目录，先安全设置 `GATEWAY_SHARED_API_KEY`）：

```sh
WORKER_CODEX_BASE_URL=https://doc.jimao.uk/summary-20261121 npm run acceptance:worker -- --shared
WORKER_CODEX_BASE_URL=https://doc.jimao.uk/summary-20261121 npm run acceptance:codex-parity
```

`WORKER_CODEX_BASE_URL` 只允许这两个已配置的 HTTPS 域名。Claude 入口继续使用原路径；新前缀专用于 Codex。

浏览器访问域名根路径时返回 AI 技术博客首页，`/notes` 和 `/notes/<文章路径>` 提供完整文章。页面为内置的静态 HTML/CSS，支持手机布局，无需前端构建或第三方资源。HTML 只在这些页面的 GET/HEAD 请求返回；API 路径仍使用原有鉴权、JSON 和流式转发逻辑。

独立的 Cloudflare Workers 子项目，使用 TypeScript、原生 Fetch API 和 Wrangler。无需 CC Switch、SQLite、服务器进程或存储服务。

每次请求必须携带 API Key。支持调用方自己的真实供应商 Key，以及配置的通用密钥：匹配通用密钥时，Worker 使用 Cloudflare Secrets 中保存的对应入口真实凭据；其他 Key 直接转发，由上游验证。

## 安装与部署

需要 Node.js 22+、npm 和 Cloudflare 账号。在仓库根目录执行：

```sh
cd worker
npm ci
```

编辑 `wrangler.jsonc` 的 Worker 名称和上游配置，然后验证、登录、部署：

```sh
npm run check
npx wrangler login
npx wrangler whoami
npm run deploy
```

部署成功后 Wrangler 会输出 `https://ai-gateway-worker.<你的子域>.workers.dev`。也可在 Cloudflare 控制台给 Worker 绑定自己的域名。CI 可以通过 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 环境变量部署。

当前 `wrangler.jsonc` 已配置自定义域名 `docs.jimao.uk`，部署时由 Cloudflare 管理域名绑定和 HTTPS 证书。客户端入口分别为 `https://docs.jimao.uk/codex/v1` 和 `https://docs.jimao.uk/claude`，健康检查为 `https://docs.jimao.uk/health`。部署到其他域名时修改 `routes` 中的 `pattern`。

本地开发：

```sh
npm run dev
```

默认本地地址为 `http://localhost:8787`；本地原有网关占用 8787 时，使用 `npm run dev -- --port 8788`。真实上游请求会使用调用方额度；自动化测试不调用真实供应商。

## 上游配置

| Wrangler vars | 默认值 | 语义 |
| --- | --- | --- |
| `CODEX_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API 根路径，追加 `/responses`、`/models` 等 |
| `CLAUDE_BASE_URL` | `https://api.anthropic.com` | Anthropic 基础路径，追加 `/v1/messages` 等 |
| `UPSTREAM_HEADER_TIMEOUT_MS` | `0` | 默认关闭额外响应头超时；可设 1–3600000 毫秒 |

例如 OpenAI 兼容供应商 API 根地址为 `https://provider.example/api/v1`，将 `CODEX_BASE_URL` 设置为该地址；请求 `/codex/v1/responses` 会转发至 `https://provider.example/api/v1/responses`。Claude 上游如果配置为 `https://provider.example/anthropic`，请求 `/claude/v1/messages` 会转发至 `https://provider.example/anthropic/v1/messages`。

上游必须使用 HTTPS，且不能包含用户名、密码、查询参数或片段。修改配置后重新部署。调用方只能使用配置好的上游，不能在请求中指定任意上游地址。不同供应商的 Key 必须匹配相应入口配置的供应商。

当前线上部署的两个入口已与本机 CC Switch 的 SudoCode 上游对齐：`CODEX_BASE_URL=https://api.sudocode.chat/v1`，`CLAUDE_BASE_URL=https://api.sudocode.chat`。因此当前需要传入相应 SudoCode Key；若使用官方 Key，请先将上游改回表格中的官方地址并重新部署。

## 客户端配置

| 客户端 | Base URL | 鉴权 |
| --- | --- | --- |
| Codex / OpenAI 兼容客户端 | `https://<Worker 域名>/codex/v1` | `Authorization: Bearer <真实 API Key>` |
| Claude Code / Anthropic 客户端 | `https://<Worker 域名>/claude` | `x-api-key: <真实 API Key>` 或 `Authorization: Bearer <真实 Token>` |

Claude 同时提供两种鉴权头时优先使用 `x-api-key`，只向上游发送选中的一种。Claude 请求缺少 `anthropic-version` 时默认补充 `2023-06-01`。模型名称、推理参数、工具参数、API 错误由客户端和上游决定；不做 Responses、Chat Completions 和 Messages 之间的转换。

以下示例中的 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 是调用终端的环境变量，不是 Worker 中存储的 Secret：

```sh
curl https://<Worker域名>/codex/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"

curl -N https://<Worker域名>/codex/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"你的上游模型","input":"Reply with OK.","stream":true}'

curl -N https://<Worker域名>/claude/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"你的上游模型","max_tokens":64,"messages":[{"role":"user","content":"Reply with OK."}],"stream":true}'
```

## 行为与边界

- HTTP 请求正文和 SSE 响应按流转发，不缓冲、不解析模型内容，不重试生成。默认不增加响应头或 SSE 空闲超时，让 Codex 和上游管理长推理请求的等待；实际连接仍受 Cloudflare 和上游限制。显式设置非零响应头超时才会额外限制等待。
- WebSocket 升级通过 Workers Fetch 原生转发，保留上游的 101 响应；供应商本身必须支持该接口。浏览器原生 WebSocket 无法设置 Bearer 请求头，请使用支持设置鉴权头的客户端。
- 不跟随上游重定向，带 Location 的 3xx 返回 `502 upstream_redirect_rejected`，避免凭据被带到重定向目标。
- 移除调用方 Cookie、代理身份头和无关 API Key；响应不下发上游 Cookie，并设置 `Cache-Control: no-store`。Cloudflare 可能管理部分传输头，因此不是 TCP 层的逐字节代理。
- 没有内置请求日志，默认关闭 Workers observability；不要在自定义日志中输出 Key 或请求正文。真实 Key 只放在鉴权头中，不放在 URL 中。
- `GET /health` 不需要 Key，只验证配置格式，不调用上游；缺少 Key 返回 401，上游错误保留其状态及响应正文，连接失败返回脱敏的 502。
- 面向原生 AI 客户端，不提供浏览器跨域 CORS 配置。没有数据库、管理界面、供应商自动选择或协议转换。

`npm run check` 包含严格类型检查、模拟上游测试、Wrangler 部署打包验证，以及 Miniflare/Workerd 运行时的 HTTP 和 WebSocket 转发测试。真实账号、供应商区域限制及真实 WebSocket 生成需部署后另外验收。

## 使用 CC Switch 凭据进行真实验收

在仓库根目录执行，依赖根项目已安装的 SQLite/TOML 适配器：

```sh
# 默认只验收 Codex；--all 同时验收 Claude
npm run acceptance:worker -- --all
```

脚本在内存中读取 CC Switch 当前供应商的真实凭据和模型，依次验证模型列表、普通生成和 SSE 生成，生成要求为 `OK`。只输出状态、耗时、模型及布尔结果，不输出凭据、原始响应、异常或模型正文；真实生成会消耗供应商额度。请求固定发往 `https://docs.jimao.uk`，上游配置与本机供应商不一致时终止。

需要对齐上游地址时可显式执行以下步骤；只将地址写入 Wrangler 配置，不会把 Key 上传或保存为 Worker Secret：

```sh
# 仓库根目录
npm run acceptance:worker -- --prepare --all
cd worker
npm run deploy
cd ..
npm run acceptance:worker -- --all
```

## 通用密钥与服务器凭据

Cloudflare Secrets 保存 `SHARED_API_KEY`、`CODEX_UPSTREAM_HEADERS` 和 `CLAUDE_UPSTREAM_HEADERS`。通用密钥按入口替换为相应上游凭据；未配置或无效的服务器凭据返回 503，不把通用密钥发给上游。真实 Key 直接转发模式继续可用。Claude 同时携带两种鉴权时仍优先选择 x-api-key。

从 CC Switch 同步当前凭据，在仓库根目录执行以下命令（终端安全输入通用密钥，不回显）：

```sh
read -s GATEWAY_SHARED_API_KEY
export GATEWAY_SHARED_API_KEY
npm run secrets:worker
npm run acceptance:worker -- --shared --all
unset GATEWAY_SHARED_API_KEY
```

同步脚本在内存中解析当前凭据，通过标准输入传给 Wrangler secret bulk；不写入文件、不输出凭据。先确认 Wrangler 登录有效、上游地址匹配。Secrets 更新后立即生效；CC Switch 后续更换 Key 时需重新同步，Worker 不会自动读取本机配置。测试会消耗供应商额度。

## 实际 Codex 对照验收

在仓库根目录安全设置 `GATEWAY_SHARED_API_KEY` 后执行：

```sh
npm run acceptance:codex-parity
npm run acceptance:codex-transport
```

需要本机 `codex` 命令（或通过 `CODEX_BIN` 指定路径）及根目录依赖。两组验收都会只读使用 CC Switch 当前 Codex 配置。CLI 验收在临时 CODEX_HOME 和临时工作目录中分别运行直连、Worker 两组会话，验证多轮恢复、medium/high 推理参数、实际文件读取工具及结果回传、SSE、取消、无效模型错误。它通过仅监听回环地址的观察代理记录模型、参数、状态及连接关闭，不输出凭据、原始请求/响应或 CLI 正文；观察代理也不保存凭据文件，结束时清除临时会话。

传输验收比较无效模型、无效 Key、未知 API 路径和真实 WebSocket 握手。错误 JSON 比较稳定字段；上游 WAF HTML 只比较状态和页面标题，忽略 Ray ID 等动态内容。当前 SudoCode WebSocket 握手两边均为 404，因此实际 Codex 验收使用 Responses SSE。未来供应商或 Codex 更新后应重新验收，不能把本次结果扩展为所有模型/所有接口均等价。

取消测试验证客户端中断并关闭下游连接，本地单元测试也验证取消流会传递到原始上游流；不据此承诺供应商服务端停止计费。CLI 生成、工具循环及取消测试会消耗供应商额度。
