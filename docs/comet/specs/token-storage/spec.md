# Capability: token-storage —— Token 存储卫生

本规格描述归档后静态 Token 凭据的文件化存储行为，作为 `SSH_MCP_TOKEN` 内联环境变量的补充。凭据校验逻辑（http-auth Spec）不变，仅新增凭据读取来源。

## 1. SSH_MCP_TOKEN_FILE

- 环境变量 `SSH_MCP_TOKEN_FILE` 指向 UTF-8 文本文件，首行非空内容（去除首尾空白与 `\n`）作为 Token 值，身份固定为 `env`；行为与 `SSH_MCP_TOKEN` 内联完全一致（校验、审计、兼容性相同）。
- 优先级与共存：`SSH_MCP_TOKEN` 与 `SSH_MCP_TOKEN_FILE` 同时设置 → 拒绝启动（二义性错误，提示只留一个）；二者与 `config.auth.tokens` 并存规则沿现状。
- 安全要求：
  - 文件不存在或不可读 → 拒绝启动并明确提示路径；
  - 文件权限宽于 0644（group/other 可写）→ 拒绝启动；权限非 0600 时打启动警告（建议 0600，不强制）；
  - 文件内容为空 → 拒绝启动（等同无凭据：HTTP 模式三来源全缺时拒绝启动的既有规则不变）。

## 2. 部署清单

- systemd 部署样例改为 `EnvironmentFile=/opt/ssh-mcp/env`（该文件 0600、root 属主）承载 `SSH_MCP_TOKEN_FILE`（或内联 Token）；`使用说明.md` 与 `CHANGELOG` 同步；提供 Token 轮换 runbook（生成 → 写文件 → `systemctl restart` → 旧 Token 验证失效）。

## 场景

Scenario: 文件读取等价内联
`SSH_MCP_TOKEN_FILE` 指向 0600 文件（内容为有效 Token）时，携带该 Token 的请求通过鉴权；错误 Token 401；行为与同值 `SSH_MCP_TOKEN` 内联完全一致。
验收：A5

Scenario: 配置二义性拒绝启动
同时设置 `SSH_MCP_TOKEN` 与 `SSH_MCP_TOKEN_FILE` → 拒绝启动，错误信息说明二者互斥。
验收：A5

Scenario: 文件异常拒绝启动
文件不存在、内容为空、或 group/other 可写时，拒绝启动并明确提示对应原因。
验收：A5
