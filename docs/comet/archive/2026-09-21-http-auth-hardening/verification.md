---
generated_from_state_version: 12
---

# 验证

## 当前结果

- 结果: **已归档**
- 验证情况: **已完成检查，验证结果已确认**
- 目标周期: 2
- 迭代: 1
- 验证器尝试次数: 1
- 完成时间: 2026-09-21T11:05:35.838Z
- 摘要: 独立运行 node test-http.js 33 项断言全绿（含完整 SSH 流程），并经 CLI 一致性复算与 fail-closed 抽查，A1-A7 全部有代码与实测证据支持，验收通过。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | A1（向后兼容）：未配置 `auth` 段、仅设置 `SSH_MCP_TOKEN` 的部署升级后行为不变——正确 Token 可正常调用，缺失/错误 Token 返回 401；完全不设置任何凭据时 HTTP 模式拒绝启动。 | 独立复跑 node test-http.js 确认：仅 SSH_MCP_TOKEN 部署错误 Token 401/正确 Token 可用，无任何凭据时非零退出并打印拒绝启动（server.js:275-281）。 |
| A2 | passed | brief.md | A2（多 Token 与过期）：配置 Token A（有效）与 Token B（`expiresAt` 已过）：A 可调用全部 4 个工具；B 返回 401；服务端日志/审计记录能区分 A 与 B 的身份。 | 有效 Token 调用成功、expiresAt 已过与 disabled 均 401，审计按 tokenId=alice/hmac 与失败指纹区分身份（auth.js:145-151）。 |
| A3 | passed | brief.md | A3（HMAC 自动轮换）：用 `scripts/derive-token.js` 由 master secret 推导当前桶 Token 可通过鉴权；前一桶（宽容窗内）可通过；更早桶返回 401；篡改 Token 中桶字段或 hex 部分返回 401。 | derive-token.js CLI 推导当前桶/±1 宽容桶通过、cur-2 越界与篡改 hex 401，--at 输出与 auth.js 库函数逐字节一致（auth.js:129-140）。 |
| A4 | passed | brief.md | A4（防爆破）：同一来源 IP 在窗口内连续达到失败阈值（默认 10 次/60 秒）后，后续请求返回 429 + `Retry-After`，封禁期（默认 10 分钟）内即使携带正确 Token 也返回 429；封禁期结束后恢复。 | 失败达阈值后 429+Retry-After、封禁期正确 Token 同拒、到期自动解除（server.js:305-316，auth.js:157-187）。 |
| A5 | passed | brief.md | A5（审计日志）：显式开启 `audit.enabled` 后，每次 `/mcp` 工具调用（成功或失败）与每次鉴权失败尝试，都在 `audit-YYYY-MM-DD.log` 产生一条 JSONL 记录，包含时间、来源 IP、Token 身份（鉴权失败标记 invalid + 指纹前 8 位）、工具名、命令/路径全文、结果 ok/error；`/healthz` 与 429 拒绝不产生审计记录。 | 审计 JSONL 完整、鉴权失败 9/9 条、429 与 /healthz 零记录、失败仅记 8 位指纹、无 Token 原值与 content_base64（auth.js:191-219）。 |
| A6 | passed | brief.md | A6（信息不泄露）：鉴权失败响应统一为 401 `unauthorized`，无法从响应区分"Token 不存在 / 已过期 / 已禁用 / HMAC 桶越界"。 | 四种失败响应体逐一比对完全一致，唯一 401 出口统一 code=-32001 unauthorized（server.js:334-336）。 |
| A7 | passed | brief.md | A7（审计默认关闭）：未配置 `audit` 或 `audit.enabled=false` 时不创建审计目录、不写任何审计文件，其余功能不受影响。 | audit.enabled=false 时空实现不做 mkdir，实测无任何审计目录/文件产生（auth.js:200）。 |

## 检查

_没有记录 Runtime 检查。_

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- node --check 全部新增/修改 js: passed — auth.js/server.js/lib.js/test-http.js/scripts/*
- node test-http.js 全场景: passed — Windows 本地 33 项检查全绿（连跑 3 轮），覆盖 A1-A7 可自动化断言，含 WSL 真实 SSH 四工具完整流程
- SEA 单文件构建: passed — WSL Node22 bash scripts/build-linux.sh 产出 122MB；新增 .gitattributes 防 CRLF 损坏构建脚本
- 实机部署验证（10.0.0.11 CentOS8）: passed — SEA 二进制实跑：17 项全链路（四工具真实 SSH/统一 401/HMAC 桶边界/429 封禁周期/审计文件核验）+ 12 项修复点定向（/ 不计数、坏 expiresAt fail-closed、非法配置拒启）；测试后现场已清理，旧生产服务未动
- 独立只读复核: passed — 发现 P2×2（限速计数范围、expiresAt fail-open）与 P3×4，全部修复并回归测试
- 已知限制: SSH_MCP_TRUST_PROXY=1 的真实 Nginx 反代链路未实测（本机无反代环境），代码路径经本地与逻辑验证
- 已知限制: 限速/封禁状态为进程内存，重启清空（brief D4 已接受）
- 已知限制: 目标机旧生产网关 /opt/ssh-mcp（127.0.0.1:18080，systemd: ssh-mcp）仍运行旧版，升级需用户决定（替换二进制+重启）

## 阻塞项

_无。_

## 风险与跳过的工作

_未报告风险。_

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 0 | recovery | — | Native Shape artifacts changed | 2026-09-21T10:56:40.867Z |
| 2 | 1 | 1 | pass | — | 独立运行 node test-http.js 33 项断言全绿（含完整 SSH 流程），并经 CLI 一致性复算与 fail-closed 抽查，A1-A7 全部有代码与实测证据支持，验收通过。 | 2026-09-21T11:05:35.838Z |



## 结论

独立运行 node test-http.js 33 项断言全绿（含完整 SSH 流程），并经 CLI 一致性复算与 fail-closed 抽查，A1-A7 全部有代码与实测证据支持，验收通过。
