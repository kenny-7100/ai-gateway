# 验收记录

日期：2026-11-15（北京时间）。项目：TypeScript + tsx CC Switch AI Gateway。

## 最终验证

| 项目 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过 |
| 本地自动化 + SSH 跨设备模拟上游 | 15 项通过，0 失败，0 跳过 |
| 远端设备访问健康检查 | HTTP 200 |
| Codex 模型列表，无 Key | HTTP 200，包含配置模型 |
| Codex 模型列表，占位 Key `12345678` | HTTP 200，包含配置模型 |
| Codex 普通 Responses，无 Key | HTTP 200，生成完成 |
| Codex SSE Responses，占位 Key | HTTP 200，收到 10 个数据事件并完成 |
| 远端真实 Codex CLI | 退出码 0，回合完成，输出符合预期 `OK` |
| 后台服务启动、状态、停止、重新启动 | 通过 |
| 项目及运行日志与本机供应商已知凭据本地比对 | 未发现匹配；未输出凭据 |
| 生产依赖 npm audit | 0 个已知漏洞 |

真实上游为 CC Switch 当前 Codex 项 SudoCode Fast，模型 `gpt-6.1-sol`。局域网设备通过 `ssh my-mac` 访问 `http://192.168.0.112:8787`。实际 Codex CLI 使用临时 CODEX_HOME 和占位 Key，未修改远端原有配置。

最后一轮普通 Responses 耗时约 29.9 秒；SSE 首个数据事件约 1.88 秒、完成约 2.01 秒。耗时是当次观测，不代表网关或供应商的稳定性能指标。

## 验收边界

按用户要求，Claude 不做最终真实上游验收。Claude HTTP/SSE 的转发由模拟上游验证，包括从另一台局域网设备调用，不涉及供应商权限。

SudoCode Responses WebSocket 在直连、系统代理及网关访问时均返回 HTTP 404。网关保留该状态；当前不能以该上游验证真实 WebSocket 生成。WebSocket 的握手、文本/二进制双向转发、拒绝握手和跨设备连接已通过模拟上游验证。

供应商切换、固定供应商与凭据轮换使用临时 SQLite 数据库验证，没有修改本机 CC Switch 的当前选择或真实凭据。

## 重现命令

```sh
LAN_SSH=my-mac LAN_HOST=192.168.0.112 \
  LAN_NODE=/Users/yy/.local/gmx-toolchains/node-v22.17.0/bin/node npm run check

ssh my-mac 'python3 - --base http://192.168.0.112:8787' < scripts/acceptance.py

ssh my-mac 'python3 - --base http://192.168.0.112:8787 --codex /Users/yy/.local/gmx-toolchains/bin/codex' \
  < scripts/acceptance-client.py
```

真实验收会使用供应商额度。模型或局域网地址改变后，相应调整参数。
