# 目标

让 ssh-mcp-server 的 HTTP 远程模式从"单一静态 Token"升级为可运营的鉴权体系：多 Token（带身份与过期）、HMAC 派生 Token 自动轮换、防爆破（限速 + 封禁）、审计日志。最终效果：端口暴露后拿不到有效凭据的人无法调用；凭据泄露可快速轮换止损；事后可追查谁在何时执行了什么。

# 范围

- HTTP 模式鉴权重构（`server.js` + `lib.js`）：
  - 兼容现状：未配置 `auth` 段时，现有 `SSH_MCP_TOKEN` 单 Token 部署行为完全不变（含缺失时拒绝启动）。
  - 多 Token：`config.json` 新增 `auth.tokens: [{id, token, expiresAt?, note?, disabled?}]`，按 `id` 区分调用方身份，过期/禁用 Token 自动失效。
  - HMAC 派生 Token（自动轮换）：`auth.hmac: {secret, periodHours?, graceBuckets?}`，默认按天分桶、接受当前 ±1 桶；Token 形如 `hmac-<bucket>-<hex>`；新增 `scripts/derive-token.js` 由 master secret 推导任意时刻桶 Token（含 `--at` 校验指定时刻），新增 `scripts/gen-token.js` 生成强随机静态 Token；文档附 cron 轮换示例与客户端静态 header 的适配说明。
- 防爆破：401 失败限速 + 连续失败封禁来源 IP（内存实现、零新依赖）；`SSH_MCP_TRUST_PROXY=1` 时信任 `X-Real-IP`/`X-Forwarded-For`（Nginx 反代场景）；封禁期请求返回 429 + `Retry-After`。
- 审计日志：`config.json` 新增 `audit: {enabled, dir?}`，**默认关闭**；显式开启后 HTTP 模式每次 `/mcp` 调用（含鉴权失败尝试）记录一条 JSONL（时间、Token 身份、来源 IP、工具名、命令/路径全文、结果），按天分文件。
- 鉴权失败对外统一 401 `unauthorized`（不区分 Token 无效/过期/禁用/HMAC 桶越界，不向攻击者泄露信息），诊断线索只进服务端日志；网关启动日志打印当前服务端 HMAC 时间桶（便于排时钟漂移）。
- 文档同步：`docs/使用说明.md` 安全配置章节扩写（多 Token、派生 Token、限速封禁、审计日志配置与轮换示例）；`docs/开发需求文档.md` FR5 扩展、非目标与后续规划相应调整（审计日志从非目标转入本期，落库/检索仍留后续）。
- 测试：`test-http.js` 扩展覆盖多 Token、过期、HMAC 桶边界、限速封禁、审计日志开关、向后兼容。

# 非目标

- 不做 Web 管理界面；不做多用户权限体系（Token 只区分身份，不做工具级授权差异）。
- 不做审计日志落库与检索界面（JSONL 文件即终点，检索交给 grep/journald）。
- 不做 HTTPS 终结（仍由 Nginx/Caddy 承担，部署文档保持现状）。
- 不改变 stdio 模式（本机进程边界保护，无鉴权）。
- 不改动命令黑名单/路径黑名单机制（`blockedCommandPatterns`/`blockedPathPatterns`）。
- 不改 MCP 工具本身（list_servers / run_command / upload_file / download_file 的参数与行为不变）。

# 验收示例

- A1（向后兼容）：未配置 `auth` 段、仅设置 `SSH_MCP_TOKEN` 的部署升级后行为不变——正确 Token 可正常调用，缺失/错误 Token 返回 401；完全不设置任何凭据时 HTTP 模式拒绝启动。
- A2（多 Token 与过期）：配置 Token A（有效）与 Token B（`expiresAt` 已过）：A 可调用全部 4 个工具；B 返回 401；服务端日志/审计记录能区分 A 与 B 的身份。
- A3（HMAC 自动轮换）：用 `scripts/derive-token.js` 由 master secret 推导当前桶 Token 可通过鉴权；前一桶（宽容窗内）可通过；更早桶返回 401；篡改 Token 中桶字段或 hex 部分返回 401。
- A4（防爆破）：同一来源 IP 在窗口内连续达到失败阈值（默认 10 次/60 秒）后，后续请求返回 429 + `Retry-After`，封禁期（默认 10 分钟）内即使携带正确 Token 也返回 429；封禁期结束后恢复。
- A5（审计日志）：显式开启 `audit.enabled` 后，每次 `/mcp` 工具调用（成功或失败）与每次鉴权失败尝试，都在 `audit-YYYY-MM-DD.log` 产生一条 JSONL 记录，包含时间、来源 IP、Token 身份（鉴权失败标记 invalid + 指纹前 8 位）、工具名、命令/路径全文、结果 ok/error；`/healthz` 与 429 拒绝不产生审计记录。
- A6（信息不泄露）：鉴权失败响应统一为 401 `unauthorized`，无法从响应区分"Token 不存在 / 已过期 / 已禁用 / HMAC 桶越界"。
- A7（审计默认关闭）：未配置 `audit` 或 `audit.enabled=false` 时不创建审计目录、不写任何审计文件，其余功能不受影响。

# 约束与不变量

- 零新增 npm 依赖（保持 SEA 单文件打包轻量）。
- HTTP 无状态模式不变（每请求独立 server + transport，不依赖会话粘性，Nginx 可随意代理）。
- `/healthz` 保持无鉴权，且不泄露除存活外的任何信息。
- 时钟依赖全部 fail-closed：HMAC 桶校验与过期判断只用网关本地时钟，时钟异常只会导致拒绝（可用性问题），绝不会导致放行（安全问题）。
- 审计日志不记录上传文件内容（base64）与下载文件内容，只记路径与元信息。
- Token 原值不出现在审计日志与错误响应中（只记 token id，鉴权失败记指纹前 8 位）。

# 决策

- D1（用户 2026-09-21 选定）：总体方向为"C + 进阶自动轮换"——保留 Bearer Token 架构，新增多 Token 管理 + HMAC 按日派生自动轮换 + 防爆破 + 审计日志。否决账密方案（与 Token 等价且更弱、更易爆破）与每请求 TOTP（MCP 客户端 header 为静态配置，无法每请求现算）。
- D2：向后兼容现有单 `SSH_MCP_TOKEN` 部署，`auth` 段缺省时行为不变；env Token 作为身份 `env` 与 config Token 并存。
- D3（用户 2026-09-21 关注时钟漂移后确认）：HMAC 默认按天分桶、宽容 ±1 桶、周期与宽容均可配；时钟依赖 fail-closed；无 NTP 内网可通过加大 `graceBuckets`、拉长 `periodHours` 或改用静态 Token 规避。
- D4：限速与封禁用进程内存实现，零新依赖（重启即清空，可接受——封禁目的为挡扫描，不需持久化）。
- D5：项目文档（`docs/使用说明.md`、`docs/开发需求文档.md`）随功能同步更新，维持既有文档规范。
- D6（用户 2026-09-21 选定）：审计日志**默认关闭**，`config.json` 显式 `audit.enabled=true` 才开启——磁盘默认无副作用，忘配置的风险由用户自担。
- D7（用户 2026-09-21 选定）：审计开启后记录**全文**（完整命令文本、上传/下载路径），便于完整复盘；文件权限由部署方管控。

# 待解决问题

（无——Q1/Q2 已由用户 2026-09-21 回答并录入决策 D6/D7。）

# 验证预期

- `node test-http.js` 全绿，覆盖 A1–A7 中可自动化场景（多 Token、过期、HMAC 桶边界、限速封禁、审计开关、兼容）。
- 手动 curl 验证 401 统一响应、429 封禁、过期 Token、HMAC 桶边界与 `scripts/derive-token.js` 输出一致性。
- 文档校验：新章节与 FR 扩展内容在两份文档中可检索到。
