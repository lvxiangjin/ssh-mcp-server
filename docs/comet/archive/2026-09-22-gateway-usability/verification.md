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
- 完成时间: 2026-09-22T07:09:37.849Z
- 摘要: A1-A5 全部通过：独立复跑 64 项端到端断言全绿（真实目标机），语法检查、bash -n、黑名单正则单测、审计/截断实现逐点核对均符合 brief 与 spec。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | A1（后台任务）：`run_command{background:true, command:"sleep 6 && echo JOB_DONE"}` 立即返回 job_id；期间 `check_job` 报 running 且能看到输出尾；完成后报 done、exit_code 0、含 JOB_DONE；对 `sleep 300` 任务 `kill_job` 后 state=killed；网关重启后 `check_job` 仍可查询同一 job_id。 | 独立复跑 node test-http.js（10.0.0.11 可达）64 项全绿：job_id 立即返回、running→done+exit_code+输出、kill→killed、非法 job_id 拒绝、网关重启后仍可查；实现含 PID 复用防误杀与 /tmp 接管防护（lib.js:275-372, server.js:229-276, test-http.js:384-406,498-513） |
| A2 | passed | brief.md | A2（cwd）：`run_command{cwd:"/etc", command:"pwd"}` 输出 `/etc`；`cwd:"/no/such/dir"` 时返回明确 shell 错误。 | cd 前缀单引号安全包裹（lib.js:167）；实测 cwd=/etc+pwd 输出 /etc、无效 cwd→shell exit_code 1（test-http.js:378-381） |
| A3 | passed | brief.md | A3（流式下载）：先经 /upload 传 8MB 随机数据，`GET /download?path=同路径` 收到的字节数与 sha256/md5 与原文件一致（响应头 `X-Md5`/`X-File-Size` 正确）；`/download` 敏感路径 400、无 token 401；审计出现 `download_stream` 条目。 | 8MB /download 字节与 sha256 一致、X-Md5/X-File-Size 头正确、敏感路径 400、无 token 401 且计入防爆破、审计 download_stream 全路径覆盖（lib.js:594-653, server.js:455,571-604, test-http.js:441-473,481-482） |
| A4 | passed | brief.md | A4（安全加固）：`scripts/setup-limited-user.sh` 存在且 `bash -n` 通过、含 sudo 白名单与 config.json 建议输出；默认黑名单下 `dd if=/dev/zero of=/dev/sda` 与 `chmod -R 777 /` 被拦截并返回命中规则。 | setup-limited-user.sh 存在且 bash -n 通过、sudoers 4 条全部强制 --no-pager 并 visudo 自校验（scripts/setup-limited-user.sh:30-35）；dd of=/dev/sd* 与 chmod -R 777 / 均拦截返回命中规则（config.json:30,34-35, test-http.js:372-375），另 10 例独立正则单测无误伤 |
| A5 | passed | brief.md | A5（审计与截断）：审计条目含 `result` 摘要字段（≤ 上限，超长带省略标记，`resultChars:0` 可关）；产出 >64KB 输出的命令响应包含开头与结尾内容且带 `…[中间省略 N 字节]…` 标记、`truncated=true`。 | 审计 result 摘要头 1024+尾 256 带省略标记、resultChars=0 关闭路径实测生效（server.js:383-394,486-489, test-http.js:239,484）；>64KB 输出保留头 60%+尾 40% 并带中间省略标记与 truncated/omittedBytes，实测 200KB 首尾标记同现（lib.js:206-238, test-http.js:409-417） |

## 检查

_没有记录 Runtime 检查。_

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- node --check 全部改动 js + bash -n 脚本: passed — lib.js/server.js/auth.js/test-http.js/setup-limited-user.sh
- node test-http.js 全场景: passed — 64 项断言连跑两轮全绿（目标机 10.0.0.11 真实服务器）：后台任务全生命周期含网关重启后可查、cwd 成功与失败、8MB 下载 sha256/X-Md5 一致、截断头尾标记、审计 result 字段与 resultChars=0 关闭路径、防爆破计数含 /download
- SEA 单文件构建: passed — WSL 构建成功 122MB
- 独立只读复核: passed — P2×4（截断 60-100% 假标记回归、sudoers pager 逃逸提权、kill_job PID 复用误杀、/tmp 任务目录接管）+ P3×11 全部修复并回归
- 已知限制: 后台命令须 POSIX 兼容（bash 存在时用 bash，否则 sh）
- 已知限制: 3GB 级真实下载的实机测速在部署后执行（本地仅 8MB 级自动化）
- 已知限制: 低权限账号切换生产配置为使用者自决（脚本只落地账号）

## 阻塞项

_无。_

## 风险与跳过的工作

- dd if=/dev/zero 写普通文件会被基线既有的 if=/dev/zero 规则拦截（33ed4cb 已存在，非本候选引入）
- check_job >7 天旧目录清理无自动化断言，仅代码审查确认（lib.js:319）

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 1 | pass | — | A1-A5 全部通过：独立复跑 64 项端到端断言全绿（真实目标机），语法检查、bash -n、黑名单正则单测、审计/截断实现逐点核对均符合 brief 与 spec。 | 2026-09-22T07:09:37.849Z |



## 结论

A1-A5 全部通过：独立复跑 64 项端到端断言全绿（真实目标机），语法检查、bash -n、黑名单正则单测、审计/截断实现逐点核对均符合 brief 与 spec。
