# Worker 真实验收记录

## 新 Codex 入口验收（2026-11-21）

部署版本：`6bd25464-9d10-4932-af12-fa34673f986b`。新增自定义域名 `doc.jimao.uk`，Codex Base URL 为 `https://doc.jimao.uk/summary-20261121`。客户端直接追加 `/responses`、`/models`，无需额外 `/v1`。旧域名和旧入口保留兼容，现有 Secrets 未更改。

新入口通用密钥验收，模型 `gpt-6.1-sol`：模型列表 HTTP 200（344 ms），普通生成 HTTP 200 且完成并输出 OK（1911 ms），SSE HTTP 200 且完成并输出 OK（2987 ms，10 个事件）。

使用 `WORKER_CODEX_BASE_URL=https://doc.jimao.uk/summary-20261121` 重新执行完整实际 Codex CLI 对照，共 12 项通过：直连与新入口各自完成基础 SSE、会话恢复、实际文件读取工具与结果回传、high 推理、取消、无效模型处理。Worker 基础 4678 ms、多轮 3657 ms、工具循环 6108 ms、high 2859 ms；取消连接关闭，无效模型 400 后 CLI 错误退出，均符合预期。

新域名健康检查 200，未鉴权模型请求 401。两个域名根路径博客均为 200 HTML，旧 Codex 入口仍正确要求鉴权。Worker 10 项模拟测试、类型检查、部署打包和 Workers 运行时检查通过；两个修改后的验收脚本通过严格类型检查。

## 实际 Codex 日常使用对照验收

2026-11-19 部署版本：`59300ff8-e171-43ae-a211-1f59fd678cb9`。域名 `https://docs.jimao.uk`，模型 `gpt-6.1-sol`，上游为当前 CC Switch 配置的 SudoCode。

移除默认额外的 120 秒响应头等待限制，`UPSTREAM_HEADER_TIMEOUT_MS=0`；可显式配置非零值。没有改动 Cloudflare Secrets。实际连接仍受上游、客户端及 Cloudflare 平台约束，不承诺无限等待。

使用本机安装的实际 Codex CLI，分别在临时 CODEX_HOME、临时工作目录运行。直连组使用本机 CC Switch 真实凭据，Worker 组使用通用密钥；凭据只在验收观察代理的内存中参与请求，Codex 本身仅使用观察代理占位 Key。观察代理只监听 127.0.0.1，不改变正文，记录脱敏的模型、推理强度、流式标志和状态，不保存原始报文或原始 CLI 输出。临时会话和配置在验收后清除。CLI 版本命令报告 `codex-cli 0.0.0`（本机 VS Code 扩展附带二进制）。

部署后的完整真实 CLI 对照共 12 项全部通过：

| 场景 | 直连 SudoCode | Worker + 通用密钥 |
| --- | --- | --- |
| Responses SSE 基础对话 | 完成，最终输出 OK，3301 ms | 完成，最终输出 OK，3654 ms |
| 恢复上一会话并回忆前一轮标记 | 完成，正确回忆，3597 ms | 完成，正确回忆，4683 ms |
| 实际调用 shell 读取 fixture.txt，再回传结果继续生成 | 工具退出 0，最终内容正确，7995 ms | 工具退出 0，最终内容正确，8019 ms |
| high 推理强度 | 请求确认为 high，输出 OK，4333 ms | 请求确认为 high，输出 OK，4037 ms |
| 流开始后向 CLI 发送 SIGINT 取消 | 请求返回 200 后连接关闭，回合未完成 | 请求返回 200 后连接关闭，回合未完成 |
| 无效模型的实际 CLI 错误处理 | 上游 400，CLI 错误退出 | 上游 400，CLI 错误退出 |

基础、多轮和工具循环均观察到 `model=gpt-6.1-sol`、`reasoning.effort=medium`、`stream=true`。工具调用有正常的两次 Responses 请求，完成工具结果回传后的生成；最终答案检查忽略 Codex 过程说明，只核对最终 agent message。

独立真实传输/错误对照也全部通过：

| 检查 | 直连 | Worker | 比较方式 |
| --- | --- | --- | --- |
| 无效模型 | 400 | 400 | 稳定 JSON 错误字段一致 |
| 无效 Key | 401 | 401 | 稳定 JSON 错误字段一致 |
| 未知 API 路径 | 403 | 403 | 上游 WAF HTML 页面标题一致，忽略动态 Ray ID/IP 等 |
| Responses WebSocket 握手 | 404 | 404 | 上游当前不支持；没有真实 WebSocket 生成结果 |

本地 Worker 严格类型检查、9 项模拟测试、Wrangler 打包及 1 项实际 Workers 运行时测试均通过。新增模拟检查验证 Codex 会话/请求/限额头、工具和推理参数保留、禁用额外超时以及 SSE 消费端取消传递至上游流。验收脚本另行通过 TypeScript 严格检查。

结论：在上述实际 Codex CLI、当前模型和 SSE 场景中，未发现 Worker 导致的使用功能差异。取消验证不证明供应商服务端停止计算或计费；未验证所有模型、图片、超长上下文、长时间运行、IDE UI 或真实 WebSocket 生成。网络延迟、出口地区、平台容量和上游 WAF 动态字段仍可能不同。本次结果不等于整个 SudoCode 服务在所有条件下逐字节一致。

复测（仓库根目录，先通过环境变量安全提供通用密钥）：

```sh
npm run acceptance:codex-parity
npm run acceptance:codex-transport
```

## 通用密钥模式验收

2026-11-19 部署版本：`2d3700f7-50bf-4064-a8f5-c8d695d0f0ed`。新增通用密钥匹配后使用 Cloudflare Secrets 中对应入口凭据的能力。当前真实凭据通过标准输入上传至 Cloudflare Secrets，未写入本地文件；此前的“没有保存为 Worker Secret”仅描述下面首轮直接转发验收时的状态。

通过 `npm run acceptance:worker -- --shared --all` 调用 `https://docs.jimao.uk`，全部成功，生成结果均由脚本确认为 `OK`：

| 模型 | 模型列表 | 普通生成 | SSE 生成 |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | HTTP 200，434 ms | HTTP 200，2281 ms | HTTP 200，2089 ms，10 个事件 |
| `claude-opus-5-5` | HTTP 200，485 ms | HTTP 200，1912 ms | HTTP 200，1802 ms，7 个事件 |

Codex SSE 首个事件 1930 ms，Claude SSE 首个事件 1768 ms。未带 Key 请求仍返回 401，健康检查返回 200。本地通过 7 项模拟测试和 1 项 Workers 运行时测试，覆盖通用密钥替换、凭据缺失/格式异常、真实 Key 转发及通用密钥 WebSocket 握手与回声。

通用密钥不在文档中重复保存。复测需在本机通过环境变量 `GATEWAY_SHARED_API_KEY` 提供。

同一部署版本也重新通过真实 Key 直接转发的 6 项线上检查：两个入口的模型列表、普通生成及 SSE 生成均为 HTTP 200，生成均完成且输出为 `OK`。

## 首轮真实 Key 直接转发验收

日期：2026-11-19（北京时间）。部署域名：`https://docs.jimao.uk`。

Worker 版本：`d7f7064c-2aa2-429a-b3c0-c43591d81777`。

使用 `scripts/acceptance-worker.ts` 在本机内存中只读解析 CC Switch 当前供应商的凭据、模型和地址。Key 通过 HTTPS 请求头传给 Worker，未输出到终端、写入验收文件或保存为 Worker Secret。未修改 CC Switch 配置。

上游已从官方默认值调整为当前 CC Switch 的 SudoCode：Codex 使用 `https://api.sudocode.chat/v1`，Claude 使用 `https://api.sudocode.chat`。修改的是上游地址配置，没有上传本机数据库或凭据。

| 入口 | 模型 | 检查 | HTTP | 结果 | 总耗时 |
| --- | --- | --- | --- | --- | --- |
| Codex | `gpt-6.1-sol` | 模型列表包含目标模型 | 200 | 通过 | 982 ms |
| Codex | `gpt-6.1-sol` | 普通 Responses，完成且输出为 OK | 200 | 通过 | 2404 ms |
| Codex | `gpt-6.1-sol` | SSE Responses，完成且输出为 OK | 200 | 通过 | 2284 ms |
| Claude | `claude-opus-5-5` | 模型列表包含目标模型 | 200 | 通过 | 1264 ms |
| Claude | `claude-opus-5-5` | 普通 Messages，完成且输出为 OK | 200 | 通过 | 1805 ms |
| Claude | `claude-opus-5-5` | SSE Messages，完成且输出为 OK | 200 | 通过 | 2134 ms |

Codex SSE 首个事件约 2228 ms，共 10 个事件；Claude SSE 首个事件约 2004 ms，共 7 个事件。这是单次观测，不代表持续性能或可用性保证。此次未进行真实 WebSocket 生成验收。

复测命令（仓库根目录）：

```sh
npm run acceptance:worker -- --all
```

脚本只输出状态和检查结果；复测会消耗供应商额度。
