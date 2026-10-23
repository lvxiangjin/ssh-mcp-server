# 目标

补齐 AI 使用方视角的五个体验与安全短板（来自 2026-09-22 实战复盘）：长命令后台执行与任务管理、大文件流式下载（对齐上传能力）、命令工作目录参数、低权限账号落地脚本与黑名单加固、审计记录执行结果摘要与输出头尾智能截断。全部落在网关自身，不改变现有部署的接入方式。

# 范围

- **P1 后台任务**：
  - `run_command` 新增可选 `background: true` 与 `cwd`（P3）参数；background 时命令以 nohup 方式在目标机 `/tmp/.ssh-mcp-jobs/<job_id>/`（out.log/pid/code）落地执行，立即返回 `job_id`；
  - 新工具 `check_job {job_id, server?, tail_lines?=50}`：返回 state（running/done/killed）、exit_code、输出尾部；顺带清理 >7 天的旧任务目录；
  - 新工具 `kill_job {job_id, server?}`：终止任务进程并标记 KILLED；
  - 任务状态文件在目标机上，网关重启不影响查询（无状态设计不变）。
- **P2 流式下载**：`GET /download?path=&server=`——SFTP 读流直透 HTTP 响应（响应头 `X-Md5`/`X-File-Size` 先行校验），复用 Bearer/防爆破/审计（`download_stream` 条目）与敏感路径拦截；不设大小上限（流式），`download_file` 工具保持现状供小文件。
- **P3 工作目录**：`run_command` 可选 `cwd` 参数——存在则前缀 `cd <cwd> &&`，目录无效由 shell 自然报错；不做跨调用状态保持（无状态设计不变）。
- **P4 安全加固**：
  - 新增 `scripts/setup-limited-user.sh <服务器内已装的公钥路径>`：在目标机上创建 `aiops` 专用账号、安装公钥、写 `/etc/sudoers.d/aiops` 白名单（status/logs/df 等只读+受控操作），打印建议的 config.json 条目；**是否切换生产配置由使用者决定，脚本只负责落地账号**；
  - 默认黑名单追加 2 条无歧义模式：`dd of=/dev/sd*`（磁盘覆写变体）、`chmod -R 777 /`（系统根全开）。
- **P5 审计与截断**：
  - 审计条目新增 `result` 摘要：`{exit_code 或 isError, text}`——取工具返回文本的头 `audit.resultChars`（默认 1024）+ 尾 256 字符，超长加省略标记；`audit.resultChars: 0` 关闭；
  - `run_command` 输出截断从"只保头"改为**保头（60%）+ 保尾（40%）**并插入 `…[中间省略 N 字节]…` 标记，`truncated`/省略字节数随响应返回。
- 文档：README、`docs/使用说明.md`（6.2 后台任务与 cwd、6.4 大文件下载指引、新增 6.6 下载端点、7.x 审计字段）、`docs/开发需求文档.md`（FR8 补下载、新增 FR9 后台任务、FR5 审计字段）。
- 测试：`test-http.js` 扩展（真实服务器场景下后台任务全生命周期、cwd、流式下载、截断头尾、审计 result 字段）。

# 非目标

- 不做有状态会话（跨调用保持 cd/环境变量）；不做 PTY/交互式终端。
- 流式下载不做断点续传与 Range。
- 不自动把生产配置从 root 切换到低权限账号（`setup-limited-user.sh` 只落地账号，切换是使用者的运维决定）。
- 后台任务不做跨网关分布式管理；目标机任务目录不做主动轮询清理（check_job 顺带清理 7 天前旧目录）。
- 审计 result 不记录 upload/download 的文件内容。

# 验收示例

- A1（后台任务）：`run_command{background:true, command:"sleep 6 && echo JOB_DONE"}` 立即返回 job_id；期间 `check_job` 报 running 且能看到输出尾；完成后报 done、exit_code 0、含 JOB_DONE；对 `sleep 300` 任务 `kill_job` 后 state=killed；网关重启后 `check_job` 仍可查询同一 job_id。
- A2（cwd）：`run_command{cwd:"/etc", command:"pwd"}` 输出 `/etc`；`cwd:"/no/such/dir"` 时返回明确 shell 错误。
- A3（流式下载）：先经 /upload 传 8MB 随机数据，`GET /download?path=同路径` 收到的字节数与 sha256/md5 与原文件一致（响应头 `X-Md5`/`X-File-Size` 正确）；`/download` 敏感路径 400、无 token 401；审计出现 `download_stream` 条目。
- A4（安全加固）：`scripts/setup-limited-user.sh` 存在且 `bash -n` 通过、含 sudo 白名单与 config.json 建议输出；默认黑名单下 `dd if=/dev/zero of=/dev/sda` 与 `chmod -R 777 /` 被拦截并返回命中规则。
- A5（审计与截断）：审计条目含 `result` 摘要字段（≤ 上限，超长带省略标记，`resultChars:0` 可关）；产出 >64KB 输出的命令响应包含开头与结尾内容且带 `…[中间省略 N 字节]…` 标记、`truncated=true`。

# 约束与不变量

- 零新增 npm 依赖；无状态 HTTP 设计不变（任务状态文件在目标机，不在网关）。
- 现有四工具的既有参数与行为不变（新增均为可选参数/新工具）；stdio 模式同样获得全部新能力。
- 审计不记文件内容与命令完整输出全文（只有受控摘要）；Token/密钥依旧不落审计。
- 目标机任务目录固定 `/tmp/.ssh-mcp-jobs/`（重启后 /tmp 清空即自然清理，符合临时语义）。
- 默认黑名单只追加"无合法用途"的模式，避免误伤合法运维命令。

# 决策

- D1（用户 2026-09-22 指示"补上这5个点"）：五点按上述范围一次性实施；P4 中低权限账号以脚本交付、生产切换保持使用者自决。
- D2：后台任务状态放目标机 `/tmp/.ssh-mcp-jobs/`——天然无状态（网关重启可查）、/tmp 重启清空即完成清理。
- D3：流式下载不做上限（与上传对称的运维通道），审计与鉴权全量覆盖；`download_file` 工具继续承担 AI 小文件场景。
- D4：审计 result 摘要默认 1024+256 字符（`audit.resultChars` 可调，0 关闭）——够复盘、不撑盘。
- D5：输出截断保尾 40%——AI 需要同时看到"命令开头回显"与"结尾汇总/报错"，只保头是本轮复盘确认的真实痛点。

# 待解决问题

（无——五点均来自 2026-09-22 使用方复盘，方案唯一确定，用户已授权免确认推进。）

# 验证预期

- `node test-http.js` 全绿（新增断言覆盖 A1–A5 可自动化部分）。
- 实机（10.0.0.11）部署后：list_tools 6 个、真实后台任务生命周期、8MB 下载端点、审计 result 字段抽查。
