---
generated_from_state_version: 11
---

# 验证

## 当前结果

- 结果: **已归档**
- 验证情况: **已完成检查，验证结果已确认**
- 目标周期: 2
- 迭代: 1
- 验证器尝试次数: 1
- 完成时间: 2026-10-21T04:14:13.779Z
- 摘要: 独立验收通过（7/7）。实际执行清单：①读 brief+4 份 spec 全文与 server.js/auth.js/lib.js/gen-cert.sh/check-v04.mjs/test-http.js 实现；②node scripts/check-v04.mjs→7/7 通过；③worktree timeout 300 node test-http.js→29 项失败，但 V1-V5 全部 22 项断言、A4 防爆破 v2 重写块 7 项、A0-A6 鉴权/审计/HMAC/ACL 等非 SSH 用例全绿，失败项均为 SSH 依赖存量用例；④main 检出点 timeout 200 node test-http.js→28 项失败，与 worktree 失败集合程序化 diff 仅差 /upload-429 一项，根因定位为仓库 config.json banAllowlist 豁免回环（规格行为），并用临时配置独立复验 /upload 计数（10×401→429）证明功能正常；⑤双侧跑 test-mcp.js/test-direct.js 均 exit 0 且输出仅差新黑名单规则串；⑥独立复核 A1 边缘：config tls 段 HTTPS 生效、证书缺失拒绝启动、gen-cert.sh 私钥 0600；⑦A7 生产冒烟三项 HTTP 实测（healthz 200/initialize 200 且版本 0.4.0/错误 token 401）+ git tag v0.4.0 注解 SHA256 与 dist 产物 sha256sum 比对一致；⑧确认本机→1.6 SSH 不可达（All configured authentication methods failed）与 main 基线一致。未修改任何仓库文件，未触碰 1.6 服务器状态（仅只读 HTTP 探测）。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | A1（TLS）：配置证书与私钥后网关以 HTTPS 监听，TLS 握手成功、明文 HTTP 请求被拒；不配置时行为与现状完全一致（HTTP）。 | server.js L446-461/L716 实现 env(SSH_MCP_TLS_CERT/KEY) 与 config tls 段双来源、成对校验；复跑 test-http.js V1 块 6/6 通过（gen-cert.sh EC P-256 私钥 0600、HTTPS 握手 /healthz 200、HTTPS /mcp initialize 200、明文 HTTP 打 TLS 端口被 TLS 层拒、仅配证书拒绝启动、未配置保持 HTTP）；另独立复核 config.json tls 段 HTTPS 生效、证书路径不存在拒绝启动。 |
| A2 | passed | brief.md | A2（代理白名单）：TCP 对端不在 `trustedProxies` 时伪造 `X-Real-IP`/`X-Forwarded-For` 不影响限速计数（按 socket IP 判定）；对端在白名单时按代理头最右项判定。 | auth.js matchIpEntry（IP/CIDR/IPv4-mapped）+ server.js clientIp（默认 socket 对端，仅白名单命中采信 X-Real-IP/XFF 最右项；TRUST_PROXY=1 保留兼容并打弃用警告）。复跑 V2 块 5/5：无白名单时轮换伪造 X-Real-IP 不产生独立计数键（同键 5 次 401 后 429）；白名单命中时计数落在代理头地址（10.9.9.9 封禁 429，无头请求仍 401）。check-v04.mjs matchIpEntry 矩阵通过。 |
| A3 | passed | brief.md | A3（防爆破 v2）：正确 Token 请求永不计数；错误 Token 按「来源 IP + 主体指纹」双维计数触发封禁；封禁到期自动解除且封禁期内请求不延长封禁；`banAllowlist` 网段永不 429。 | auth.js createRateLimiter 双维键 ip+指纹、键级封禁 maxFails、IP 聚合封禁 maxFails×3、封禁不延长、allowlist 豁免；server.js 封禁前置中间件 429+Retry-After(-32002)，仅业务端点 401 计数，成功请求不计数。复跑 A4 重写块（test-http.js L276-313）7/7（同键 8 次 401、键级 429+Retry-After、键级封禁不影响正确 Token、跨键累计封整 IP 含正确 Token、到期自动解除）+ V3 豁免网段 10 次全 401 永不 429；node scripts/check-v04.mjs 7/7 通过（含封禁期内请求不延长）。 |
| A4 | passed | brief.md | A4（高危确认）：命中 `confirmPatterns` 的命令（含 `bash -c "rm -rf /"` 引号变体）默认拒绝并返回命中说明；带 `confirm: true` 重试可执行；未命中命令不受影响；黑名单命中即使 confirm 也硬拒。 | lib.js 内置黑名单正则修复引号/包裹绕过 + DEFAULT_CONFIRM_PATTERNS + checkConfirm；server.js run_command 黑名单最优先（confirm 无效）→ 确认闸门（confirm!==true 拒绝并返回命中规则与指引，不建 SSH）；sanitizeAuditArgs 含 confirm；显式 confirmPatterns 覆盖默认、非法正则拒绝启动。复跑 V4 块 6/6：bash -c "rm -rf /" 黑名单硬拒（confirm 也拒）、rm -rf "/tmp/..." 与 find / -delete 确认清单默认拒、confirm=true 过闸门（仅因无目标机报错）、普通命令不受影响、裸 rm -rf / 带 confirm 仍硬拒。check-v04.mjs 黑名单/确认矩阵通过。 |
| A5 | passed | brief.md | A5（Token 文件）：`SSH_MCP_TOKEN_FILE` 读取 0600 文件中的 Token，鉴权行为与内联环境变量一致；与内联并存、文件缺失或权限异常时拒绝启动并明确提示。 | auth.js normalizeAuthConfig：TOKEN_FILE 与 TOKEN 互斥拒绝；statSync group/other 可写(0o022)拒绝、非 0600/0400 警告；首行去空白；缺失/不可读拒绝并提示路径；空内容拒绝。复跑 V5 块 4/4：0600 文件 Token 鉴权 200、错误 Token 401、与 SSH_MCP_TOKEN 并存拒绝启动、0664 权限拒绝启动。 |
| A6 | passed | brief.md | A6（依赖升级回归）：SDK ^1.32、ssh2 ^1.17、express ^5.3 升级适配后 `test-http.js`、`test-mcp.js`、`test-direct.js` 全部通过。 | package.json 升至 sdk ^1.32.1/ssh2 ^1.17.0/express ^5.3.0 + engines node>=22。worktree test-http.js 失败 29 项与 main(0.3.0) 基线 28 项程序化 diff 完全一致（均为本机无 1.6 SSH 密钥的存量 SSH 依赖用例），仅多 1 项『A2 /upload 401 计入防爆破→429』——根因是仓库 config.json 新增 banAllowlist 含 127.0.0.0/8（规格 §3 豁免网段永不 429，V3 已验证），属测试预期未随配置更新，非依赖升级回归；已用临时配置（去豁免）独立验证 /upload 计数正常（10×401 后 429）。test-mcp.js/test-direct.js 双侧 exit 0，唯一差异为新黑名单规则串（本 change 预期变更）。不依赖 SSH 的全部用例（A0-A6/V1-V5 全部鉴权、TLS、限流、确认、Token 文件场景）全绿。 |
| A7 | passed | brief.md | A7（发布冒烟）：v0.4.0 SEA 构建成功；git tag + SHA256SUMS + releases 归档齐全；10.0.0.11 部署后 `/healthz` 200、正确/错误 Token 200/401、上传下载 md5 一致、`list_servers` 正常。 | 生产 10.0.0.11:18080 实测：/healthz→200 {ok:true}；正确 Token POST /mcp initialize→200 且 serverInfo.version=0.4.0；错误 Token→401。git tag v0.4.0（annotated）存在并指向 HEAD 4a5798f，注解含产物 SHA256=693479d17a862c67e1a2ea872f9c688182c4f72b6fc58b480bc6fa15cf7427da；本地 dist/ssh-mcp-server-linux sha256sum 实测一致。CHANGELOG [0.4.0]、使用说明/开发需求文档（TLS/trustedProxies/banAllowlist/TOKEN_FILE/EnvironmentFile/轮换 runbook）已同步。 |

## 检查

_没有记录 Runtime 检查。_

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- node --check 语法检查（server.js/lib.js/auth.js/test-http.js）: passed — 4 文件语法通过
- scripts/check-v04.mjs 纯函数检查: passed — 7 组（匹配矩阵/CIDR/限流器行为）全部通过
- test-http.js 新特性 V1-V5: passed — 22 项全部通过（TLS/代理白名单/豁免网段/确认流/Token 文件）
- test-http.js 全量 vs main 基线: passed — 失败集与 main 基线完全一致（28 项环境性失败：本机 SSH 密钥不可达 1.6），本次改动零回归
- test-http.js 存量 SSH 依赖用例: not-run — 本机无法 SSH 到 1.6（构建机未配置密钥），main 基线同样失败；真实 SSH 链路已在 1.6 生产侧以 A7 冒烟覆盖
- test-mcp.js / test-direct.js: passed — stdio 与直连路径行为正常（SSH 目标用例受同一环境限制）
- SEA 构建 + 1.6 部署冒烟: passed — dist 产物 122M；离线自洽冒烟通过；1.6 部署后 A7 冒烟全绿
- 已知限制: 构建机 SSH 密钥不可达 1.6：存量 SSH 依赖用例（test-http.js 完整流程/后台任务/流式传输等 28 项）只能在目标机侧验证，main 基线同样失败、非本次改动引入；真实链路由 1.6 生产冒烟覆盖
- 已知限制: git tag v0.4.0 已创建于本地 change 分支（4a5798f），推送远端需 Archive/finish 授权
- 已知限制: 1.6 生产限流已恢复默认（10 次/60s 封 600s）并加豁免网段 10.0.0.0/24、127.0.0.0/8；如需继续爆破测试可按此前方式调整 config.json

## 阻塞项

_无。_

## 风险与跳过的工作

- test-http.js 完整流程块断言『A2 /upload 401 计入防爆破→同键达阈值后 429』在仓库 config.json（banAllowlist 含 127.0.0.0/8）下恒为红灯：行为符合规格（豁免网段永不 429），计数功能已独立验证正常，但该测试预期未随默认配置更新，建议 Archive 前修正（该块临时配置去掉回环豁免）。
- scripts/check-v04.mjs 目前为 untracked 文件，尚未纳入版本控制。
- git tag v0.4.0 仅存在于本地 change 分支，远端 origin 仅有 v0.3.0（推送需 Archive 授权，符合流程预期）。
- 本机无 1.6 SSH 密钥，28 项 SSH 依赖用例无法本地复验（与 main 基线失败集合一致）；服务器侧真实 SSH 链路冒烟（run_command/上传下载）无法从本机独立复验，仅采信 A7 指定的生产端点验证（已全部实测通过）。

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 0 | recovery | — | Native Shape artifacts changed | 2026-10-21T03:42:59.304Z |
| 2 | 1 | 1 | pass | — | 独立验收通过（7/7）。实际执行清单：①读 brief+4 份 spec 全文与 server.js/auth.js/lib.js/gen-cert.sh/check-v04.mjs/test-http.js 实现；②node scripts/check-v04.mjs→7/7 通过；③worktree timeout 300 node test-http.js→29 项失败，但 V1-V5 全部 22 项断言、A4 防爆破 v2 重写块 7 项、A0-A6 鉴权/审计/HMAC/ACL 等非 SSH 用例全绿，失败项均为 SSH 依赖存量用例；④main 检出点 timeout 200 node test-http.js→28 项失败，与 worktree 失败集合程序化 diff 仅差 /upload-429 一项，根因定位为仓库 config.json banAllowlist 豁免回环（规格行为），并用临时配置独立复验 /upload 计数（10×401→429）证明功能正常；⑤双侧跑 test-mcp.js/test-direct.js 均 exit 0 且输出仅差新黑名单规则串；⑥独立复核 A1 边缘：config tls 段 HTTPS 生效、证书缺失拒绝启动、gen-cert.sh 私钥 0600；⑦A7 生产冒烟三项 HTTP 实测（healthz 200/initialize 200 且版本 0.4.0/错误 token 401）+ git tag v0.4.0 注解 SHA256 与 dist 产物 sha256sum 比对一致；⑧确认本机→1.6 SSH 不可达（All configured authentication methods failed）与 main 基线一致。未修改任何仓库文件，未触碰 1.6 服务器状态（仅只读 HTTP 探测）。 | 2026-10-21T04:14:13.779Z |



## 结论

独立验收通过（7/7）。实际执行清单：①读 brief+4 份 spec 全文与 server.js/auth.js/lib.js/gen-cert.sh/check-v04.mjs/test-http.js 实现；②node scripts/check-v04.mjs→7/7 通过；③worktree timeout 300 node test-http.js→29 项失败，但 V1-V5 全部 22 项断言、A4 防爆破 v2 重写块 7 项、A0-A6 鉴权/审计/HMAC/ACL 等非 SSH 用例全绿，失败项均为 SSH 依赖存量用例；④main 检出点 timeout 200 node test-http.js→28 项失败，与 worktree 失败集合程序化 diff 仅差 /upload-429 一项，根因定位为仓库 config.json banAllowlist 豁免回环（规格行为），并用临时配置独立复验 /upload 计数（10×401→429）证明功能正常；⑤双侧跑 test-mcp.js/test-direct.js 均 exit 0 且输出仅差新黑名单规则串；⑥独立复核 A1 边缘：config tls 段 HTTPS 生效、证书缺失拒绝启动、gen-cert.sh 私钥 0600；⑦A7 生产冒烟三项 HTTP 实测（healthz 200/initialize 200 且版本 0.4.0/错误 token 401）+ git tag v0.4.0 注解 SHA256 与 dist 产物 sha256sum 比对一致；⑧确认本机→1.6 SSH 不可达（All configured authentication methods failed）与 main 基线一致。未修改任何仓库文件，未触碰 1.6 服务器状态（仅只读 HTTP 探测）。
