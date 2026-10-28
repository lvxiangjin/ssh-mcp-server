# Capability: gateway-usability —— 后台任务/流式下载/工作目录/安全加固/审计增强

本规格描述归档后网关在 FR1-FR8 之外新增的能力细节。

## 1. 后台任务（P1）

### 1.1 run_command 扩展
- 可选 `background: boolean`：为 true 时不等待执行，命令以 nohup 在目标机后台启动，立即返回：
  `后台任务已启动 server: <id> job_id: <hex>（用 check_job 查询进度/结果）`。
- 可选 `cwd: string`：命令执行前先 `cd <cwd>`（前台与后台均生效；后台时 cd 包含在远程包装脚本内），目录不存在由 shell 返回错误。
- 黑名单/超时语义：background 命令仍过黑名单；超时参数不适用（后台无超时）。

### 1.2 目标机任务目录
- 固定 `/tmp/.ssh-mcp-jobs/<job_id>/`：`out.log`（合并输出）、`pid`（包装进程号）、`code`（退出码，结束时写入；被 kill 时写入 KILLED）。
- job_id 为 12 位随机 hex；目录随 /tmp 重启自然清理；check_job 顺带删除 >7 天的旧目录。

### 1.3 check_job 工具
- 参数 `{job_id, server?, tail_lines?=50}`；返回文本含 state（running/done/killed/unknown）、exit_code（结束时）、输出尾部 N 行。
- 副作用：清理目标机 >7 天的旧任务目录。

### 1.4 kill_job 工具
- 参数 `{job_id, server?}`：kill 包装进程及其直接子进程（TERM，宽限 0.5s 后 KILL），写入 KILLED 标记；返回文本说明结果。

## 2. 流式下载 GET /download（P2）

- 查询参数 `path`（必填，绝对路径）、`server`（可选）；Bearer/防爆破/敏感路径拦截与 /mcp、/upload 同一套。
- 流程：目标机 `stat` 取大小 → `md5sum` → 响应头 `X-Md5`、`X-File-Size`、`Content-Length` → SFTP 读流直透响应体；任一前置失败返回 JSON 错误（400/401/404/500）。
- 不设大小上限；`download_file` 工具保持现状（AI 小文件场景），文档指引大文件走 GET /download。
- 审计：每次调用（成功或失败）记 `download_stream` 条目（路径/字节/身份/IP），不记内容。

## 3. 审计 result 摘要与智能截断（P5）

- run_command/check_job/kill_job 及所有工具调用审计条目新增 `result: {exit_code 或 isError, text}`；text 为返回文本摘要：头部 `audit.resultChars`（默认 1024）+ 尾部 256 字符，中间以 `…[审计省略 N 字符]…` 连接；`audit.resultChars: 0` 时不记录 result。
- run_command 前台输出超 `maxOutputBytes` 时不再只保头：保留头部 60% + 尾部 40%，中间插入 `\n…[中间省略 N 字节]…\n`；`truncated=true` 与省略字节数随结果返回。

## 4. 安全加固（P4）

- 默认黑名单追加：`dd ... of=/dev/sd*`（磁盘覆写变体）、`chmod -R 777 /`（系统根全开）。
- `scripts/setup-limited-user.sh <公钥文件>`：目标机上执行（root），创建 `aiops` 用户 + 安装公钥 + 写 `/etc/sudoers.d/aiops`（只读与受控运维白名单：systemctl status/list/journalctl/df/du/free/ps/ss 等）+ 打印建议的 config.json 条目；不改动现有生产配置。

## 5. 工具清单（归档后）

list_servers / run_command（+background,cwd）/ **check_job（新）** / **kill_job（新）** / upload_file / download_file —— 共 6 个；HTTP 端点：/healthz、/mcp、/upload、/download。
