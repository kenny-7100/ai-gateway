# Worker 真实验收记录

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
