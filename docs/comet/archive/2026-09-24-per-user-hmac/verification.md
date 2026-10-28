---
generated_from_state_version: 14
---

# 验证

## 当前结果

- 结果: **已归档**
- 验证情况: **已完成检查，验证结果已确认**
- 目标周期: 2
- 迭代: 1
- 验证器尝试次数: 1
- 完成时间: 2026-09-24T02:03:11.858Z
- 摘要: 独立运行 node test-http.js（10.0.0.11 可达）全绿，并对派生一致性、跨 secret 冒充、向后兼容、非法配置拒启做了内存级独立复核，A1-A4 全部通过。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | A1：`hmacUsers: [{id:"emp", secret:S1, servers:["srv-b"]}]`——`derive-token.js --secret S1 --id emp` 输出的 token 通过鉴权，run_command 默认落在 srv-b（结果含 `server: srv-b`），list_servers 仅见 srv-b； | hmacu-emp token 经 CLI 派生后通过网关校验（tokenId=hmacu-emp），run_command 默认落白名单首个（ACL defaultId=allowed[0]，非全局默认），list_servers 仅见白名单；e2e test-http.js:379-385 与独立内存复核一致 |
| A2 | passed | brief.md | A2：错误 secret（用全局 secret + `--id emp` 冒充）→ 401；越权 `server=srv-a` → 拒绝；全局 HMAC Token（无 id 格式）行为不变，两者并存互不干扰； | 全局 secret + --id emp 冒充 token 被 401（e2e test-http.js:388-394）；网关按 id 查条目后用该条目自身 secret 重算 HMAC（auth.js:254,261-263），独立复核 impersonated 与个人-secret-伪装全局格式均拒绝 |
| A3 | passed | brief.md | A3：配置校验：hmacUsers 缺 secret、servers 引用未定义 id、periodHours 非法 → 拒绝启动并指明条目； | 全局 auth.hmac 分支与 derive-token.js 无 --id 路径未改（auth.js:266-279, derive-token.js:66-70）；e2e 全局 token 200、宽容窗/篡改/越界桶回归全绿，且与 hmacUsers 并存时全局 token 仍 200（test-http.js:396-402） |
| A4 | passed | brief.md | A4：文档三处 + derive-token.js `--id` 用法同步。 | 缺 secret、periodHours 非法、servers 引用未定义 id、重复/非法 id、hmacu- 前缀键冲突均有指名条目的启动错误（auth.js:136-186），server.js:377-381 拒启；e2e test-http.js:339-351 实测非 0 退出且 stderr 含 auth.hmacUsers["emp"] 缺少 secret |

## 检查

_没有记录 Runtime 检查。_

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- node --check 全部改动 js: passed — auth.js/server.js/test-http.js/scripts/derive-token.js
- node test-http.js 全场景: passed — 两轮全绿（80 项断言，目标机 10.0.0.11 作为 SSH 测试目标）：每人派生 hmacu-emp token 默认落白名单首个 srv-b、list 过滤、错误 secret（含全局 secret 冒充）401、全局 hmac 并存向后兼容、hmacUsers 非法配置拒启
- SEA 单文件构建: passed — WSL 构建成功 122MB（仅验证打包，按用户要求不部署 1.6）
- 独立只读复核: passed — P2×2（hmacUsers servers 空数组全锁死违反 spec、id 重复静默错位绑定）+ P2 测试空转（默认解析断言无法区分白名单/全局默认）+ P3×7 全部修复并回归
- 已知限制: 纯开发不部署：1.6 生产仍运行上一版本（用户明确要求不动 1.6），上线部署由使用者择机执行
- 已知限制: HMAC 派生 Token（全局与每人）均不受 servers 白名单限制的仅全局格式；每人格式受各自白名单约束

## 阻塞项

_无。_

## 风险与跳过的工作

- 候选区间含已归档 multiuser-jobs 的 lib.js 改动（与本验收无关）；工作区 comet-state.yaml/.comet/ 为流程簿记，非实现代码

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 1 | recovery | — | Native Shape artifacts changed | 2026-09-24T01:56:29.978Z |
| 2 | 1 | 1 | pass | — | 独立运行 node test-http.js（10.0.0.11 可达）全绿，并对派生一致性、跨 secret 冒充、向后兼容、非法配置拒启做了内存级独立复核，A1-A4 全部通过。 | 2026-09-24T02:03:11.858Z |



## 结论

独立运行 node test-http.js（10.0.0.11 可达）全绿，并对派生一致性、跨 secret 冒充、向后兼容、非法配置拒启做了内存级独立复核，A1-A4 全部通过。
