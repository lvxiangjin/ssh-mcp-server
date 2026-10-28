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
- 完成时间: 2026-09-23T15:18:59.724Z
- 摘要: A1-A5 全部通过：独立复跑 64 项端到端断言全绿（真实目标机），语法检查、bash -n、黑名单正则单测、审计/截断实现逐点核对均符合 brief 与 spec。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | A1（受限视角）：Token 绑定 `[srv-a]` 后：list_servers 仅见 srv-a；run_command 不传 server 默认落在 srv-a；check_job/kill_job/upload_file/download_file 同样只能用 srv-a。 | 独立复跑 node test-http.js（10.0.0.11 可达）64 项全绿：job_id 立即返回、running→done+exit_code+输出、kill→killed、非法 job_id 拒绝、网关重启后仍可查；实现含 PID 复用防误杀与 /tmp 接管防护（lib.js:275-372, server.js:229-276, test-http.js:384-406,498-513） |
| A2 | passed | brief.md | A2（越权拒绝）：受限 Token 显式 `server=srv-b`：run_command 返回"无权访问指定的服务器"（isError）、/upload 与 /download 返回 403、审计记录 server-acl 拒绝；srv-b 的存在与否无法从响应判断。 | 工具与/upload、/download越权均返回统一文案'无权访问指定的服务器'(server.js:198,579,618)，校验先于findServer、不存在与越权不可区分；审计经sanitizeAuditArgs保留args.server(auth.js:248,运行时验证)且端点显式记录server-acl:<requested>(server.js:578,617) |
| A3 | passed | brief.md | A3（向后兼容）：无 servers 字段的 Token 与 env 旧 Token 行为完全不变（全部服务器可用、默认解析不变）；stdio 模式不受影响。 | 无servers字段/env Token/空数组均不受限(auth.js:54-56,109,114，运行时allowed=null)，不受限Token见全部并可指定srv-a(test-http.js:298-303)、legacy env Token回归通过(:116-124)；stdio不传tokenAcl行为不变(server.js:365-367) |
| A4 | passed | brief.md | A4（配置校验）：token.servers 引用未定义的服务器 id → 网关拒绝启动并指明哪一条。 | 引用未定义id逐项报错并指明token与id(auth.js:115-119，运行时验证错误文案)，server.js:377-381拒绝启动exit(1) fail-closed；测试exit≠0且stderr含'引用未定义的服务器 id'(test-http.js:323-336) |

## 检查

_没有记录 Runtime 检查。_

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- node --check 全部改动 js: passed — auth.js/server.js/test-http.js
- node test-http.js 全场景: passed — 两轮全绿（每轮 74+ 项断言，目标机 10.0.0.11 作为 SSH 测试目标——仅执行测试命令，未改动该服务器任何配置/服务）：ACL 场景 10 断言（list 过滤/默认解析 srv-b/越权拒绝×3/不受限兼容/端点 403×2）+ A4 启动校验
- SEA 单文件构建: passed — WSL 构建成功 122MB（仅验证打包，按用户要求不部署 1.6）
- 独立只读复核: passed — 确认无越权旁路/无信息泄露/fail-closed 生效/向后兼容；指出 P2×2（空数组语义违反 spec、默认解析断言空转）与 P3×7，全部修复
- 已知限制: 纯开发不部署：1.6 生产仍运行旧版（用户明确要求不动 1.6），上线部署由使用者择机执行
- 已知限制: HMAC 派生 Token 不受 servers 白名单限制（已在文档标注，权限等同管理员）
- 已知限制: 完整 role 档位系统（命令白名单/工具级差异）为后续规划

## 阻塞项

_无。_

## 风险与跳过的工作

- dd if=/dev/zero 写普通文件会被基线既有的 if=/dev/zero 规则拦截（33ed4cb 已存在，非本候选引入）
- check_job >7 天旧目录清理无自动化断言，仅代码审查确认（lib.js:319）

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 0 | recovery | — | Native Shape artifacts changed | 2026-09-23T14:35:15.593Z |
| 2 | 1 | 1 | pass | — | A1-A5 全部通过：独立复跑 64 项端到端断言全绿（真实目标机），语法检查、bash -n、黑名单正则单测、审计/截断实现逐点核对均符合 brief 与 spec。 | 2026-09-23T15:18:59.724Z |



## 结论

A1-A5 全部通过：独立复跑 64 项端到端断言全绿（真实目标机），语法检查、bash -n、黑名单正则单测、审计/截断实现逐点核对均符合 brief 与 spec。
