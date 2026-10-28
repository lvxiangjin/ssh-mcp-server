---
generated_from_state_version: 9
---

# 验证

## 当前结果

- 结果: **已归档**
- 验证情况: **已完成检查，验证结果已确认**
- 目标周期: 1
- 迭代: 1
- 验证器尝试次数: 1
- 完成时间: 2026-09-21T14:25:12.317Z
- 摘要: 两轮独立运行 node test-http.js 全绿（46 项断言，含 10.0.0.11 真实服务器的完整流程与流中场景），A1-A5 五项验收全部通过，仅余 3GiB 实机全量比对为部署后遗留动作。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | A1（流式上传全流程）：对可达服务器的网关，POST 8MB 随机数据到 `/upload?path=/tmp/x.bin`，返回 200 `{ok:true, bytes, md5}` 且 bytes/md5 与本地计算一致；`mode=0600` 生效。 | 独立运行 node test-http.js：8MB 随机数据 /upload 返回 200、bytes/md5 与本地一致、stat 确认 mode=0600（test-http.js:392-405；lib.js:306-421/394/397，server.js:443） |
| A2 | passed | brief.md | A2（鉴权与审计）：错误 token 调 `/upload` 返回 401 且计入防爆破失败数；成功/失败调用在审计中产生 `tool:"upload_stream"` 条目（含 bytes，不含文件内容）。 | /upload 错误 token 401 计入防爆破、达阈值后 429（server.js:342-344；test-http.js:416-424），审计 upload_stream 条目含 bytes/md5/tokenId 且无文件内容（server.js:414-415/441；test-http.js:408-413） |
| A3 | passed | brief.md | A3（上限控制）：`Content-Length` 超过 `maxStreamUploadBytes` 即刻 413（不建立 SSH 连接）；流中超限返回 413 且远端半截文件被清理（不留残片）。 | Content-Length 预检 413 不建 SSH（server.js:431-437）、chunked 流中超限 413 且远端残片清理（lib.js:410-414/339-346；test-http.js:327-337）、path/mode/黑名单 400（server.js:417-429；test-http.js:301-306）全部实测通过 |
| A4 | passed | brief.md | A4（MCP 路径修复）：HTTP 模式下经 `upload_file` 上传 200KB 文件（JSON 请求体约 273KB > 旧默认 100KB 限制）成功。 | express.json limit 按 maxUploadBytes*1.4+256KB 动态计算且仅挂 /mcp（server.js:315/358），HTTP 模式 MCP upload_file 200KB（body 约 273KB>旧 100KB 限）实测成功（test-http.js:373-378） |
| A5 | passed | brief.md | A5（文档与配置）：`maxStreamUploadBytes`、curl 示例、Nginx 说明写入三份文档；FR8 入开发需求文档。 | maxStreamUploadBytes=3GiB（lib.js:51）与 curl/Nginx 说明写入 README.md:145-174/238、docs/使用说明.md §6.5+§7.6、FR8+断点续传写入 docs/开发需求文档.md:118-132/178，均 grep 检索确认 |

## 检查

_没有记录 Runtime 检查。_

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- node --check 全部改动 js: passed — lib.js/server.js/test-http.js
- node test-http.js 全场景（目标机 10.0.0.11 真实服务器）: passed — 40 项断言连跑两轮全绿：A1 8MB 流式上传 md5 比对+mode=0600、A2 审计 upload_stream/401 计数到 429、A3 Content-Length 413+chunked 流中超限+残片清理+黑名单拦截+path/mode 校验、A4 MCP 200KB（HTTP body 超 100KB 旧限）、A5 文档
- SEA 单文件构建: passed — WSL 构建成功 122MB
- 独立只读复核: passed — P1-1 两条中断路径 Promise 挂起（入口接管断连事件+看门狗+safeExec 兜底）、P2-1 express.json 吞 /upload 体（收窄到 /mcp）、P2-2 /upload 补敏感路径黑名单、P2-3 空闲看门狗、P3 若干（审计 md5/误删旧文件/魔法串/配置校验/测试缺口/config.json.bak 混入），全部修复
- 已知限制: 3GB 级真实传输的最终实测在部署到 10.0.0.11 后执行（本地仅 8MB 级自动化）
- 已知限制: requestTimeout=0 为全局开关，/mcp 的停滞连接依赖 headersTimeout（60s）与客户端超时防护
- 已知限制: 上传断点续传/分块为后续规划（FR8 非目标）

## 阻塞项

_无。_

## 风险与跳过的工作

- rmPartial 以 sleep 0.3 兜底清理迟到残片（lib.js:344），极端慢盘下理论上可能残留 0 字节文件（本轮实测清理成功）
- 真实 3GiB 传输未在测试中执行（仅 8MB），brief 验证预期中的 3GiB 实机 md5 比对为部署后遗留动作

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 1 | pass | — | 两轮独立运行 node test-http.js 全绿（46 项断言，含 10.0.0.11 真实服务器的完整流程与流中场景），A1-A5 五项验收全部通过，仅余 3GiB 实机全量比对为部署后遗留动作。 | 2026-09-21T14:25:12.317Z |



## 结论

两轮独立运行 node test-http.js 全绿（46 项断言，含 10.0.0.11 真实服务器的完整流程与流中场景），A1-A5 五项验收全部通过，仅余 3GiB 实机全量比对为部署后遗留动作。
