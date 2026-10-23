# Capability: multiuser-jobs —— 后台任务目录按账户隔离

任务目录布局：`/tmp/.ssh-mcp-jobs/<SSH账户名>/<job_id>/`（out.log/pid/code/killed 同前）。

- 根目录：`install -d -m 0711`（其他用户可穿越+创建、不可列举），拒绝符号链接；属主为首个创建者（合法，不做单属主校验）；
- 账户目录：`install -d -m 700` + 属主校验（须为当前 SSH 账户）——防接管/防误删语义保留在账户级；
- checkJob 的 7 天清理仅作用于当前账户子目录；
- 其余行为（job_id、check/kill 语义、审计）不变。
