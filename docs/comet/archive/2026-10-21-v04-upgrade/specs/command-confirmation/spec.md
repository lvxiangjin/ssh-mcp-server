# Capability: command-confirmation —— 高危命令二次确认

本规格描述归档后 `run_command` 工具的高危命令二次确认行为，适用于 HTTP 与 stdio 两种传输（行为一致）。既有 `blockedCommandPatterns` 硬黑名单继续兜底且优先级最高；确认层在其后、执行之前。

## 1. 确认清单

- 配置：`auth.confirmPatterns`（正则字符串数组，编译为不区分大小写）。缺省时使用内置默认清单，覆盖以下形态（含引号包裹、`bash -c`/`sh -c`/`eval` 包装、变量拼接间隔等变体）：
  - `rm` 携带 `-r` 与 `-f` 作用于根或通配根路径（`rm -rf /`、`rm -fr /*`、`bash -c "rm -rf /"` 等）；
  - `mkfs`、`dd` 写入磁盘设备（`of=/dev/(sd|hd|nvme|vd)`）、`dd if=/dev/(zero|random)`；
  - `shred` 作用于块设备；
  - `find` 携带 `-delete` 作用于根或系统目录；
  - 重定向截断系统关键文件（`>` 作用于 `/etc/passwd|/etc/shadow|/etc/sudoers|/etc/ssh/sshd_config` 等）。
- 显式配置 `confirmPatterns` 时完全覆盖默认清单（不做合并）；非法正则拒绝启动。
- 命中黑名单（`blockedCommandPatterns`）的命令仍直接硬拒（响应不变，不提供确认途径）。

## 2. run_command 交互流程

- `run_command` 入参新增可选布尔参数 `confirm`（默认 false）。
- 命中确认清单且 `confirm` 非 true：**不建立 SSH 连接、不执行**，返回文本说明：命中的规则编号/片段、命令原文、以及「确认后请携带 `confirm: true` 重新调用」的指引；该次调用不产生副作用。
- 命中确认清单且 `confirm: true`：正常执行；审计条目记录 `confirm: true`（`sanitizeAuditArgs` 白名单补 `confirm` 字段）。
- 未命中确认清单的命令：行为与现状完全一致（`confirm` 参数存在与否无影响）。
- 其余工具（`list_servers`/`check_job`/`kill_job`/`upload_file`/`download_file` 及流式端点）不受本机制影响。

## 3. 与黑名单的关系

黑名单修复引号绕过：`rm -rf /` 类规则扩展为覆盖命令包裹形态（`bash -c "…"`、`sh -c '…'` 内层的 rm -rf 根路径同样命中黑名单或确认清单，二者必居其一，不允许放行）。确认清单匹配发生在黑名单之后：黑名单命中的命令即使 `confirm: true` 也拒绝。

## 场景

Scenario: 根分区引号变体被黑名单兜死
执行 `bash -c "rm -rf /"`（0.3.x 中因正则缺陷会放行），命中内置黑名单被硬拒且未执行；同一命令带 `confirm: true` 仍被硬拒（黑名单优先，不提供确认途径）。
验收：A4

Scenario: 引号路径递归强删走确认流
执行 `rm -rf "/tmp/demo-dir"`：命中确认清单默认拒绝并返回命中说明与指引；同一命令带 `confirm: true` 重试，通过确认闸门进入正常执行链路。
验收：A4

Scenario: 未命中命令不受影响
执行普通命令（如 `df -h`、`ls /opt`），无论是否携带 `confirm`，行为与现状一致。
验收：A4

Scenario: 确认流无副作用
命中确认清单且未带 `confirm` 的调用不产生 SSH 连接与远端执行；拒绝说明中包含命中规则信息与确认指引。
验收：A4

Scenario: 黑名单优先于确认
命中 `blockedCommandPatterns` 的命令（如裸 `rm -rf /`、`mkfs.ext4 /dev/sda`）即使带 `confirm: true` 仍被硬拒。
验收：A4
