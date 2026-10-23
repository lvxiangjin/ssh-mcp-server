# 目标

让每个外部调用方（角色）拥有**自己独立的 HMAC secret**，并各自绑定服务器白名单——既享受"token 每天自动轮换、泄露只坏当天"的便利，又保持"只能访问指定服务器"的分级约束。当前实现只有一个全局 `auth.hmac.secret`（推导出的 token 权限等同管理员、不受白名单限制），无法安全地发给多个不同角色的调用方。

# 范围

- `auth.js` normalize：新增 `auth.hmacUsers[]` 解析：`{ id, secret, servers?, periodHours?, graceBuckets? }`；校验：id 须匹配 `[a-z0-9_-]+`、secret 须非空（<32 字符告警）、servers 引用须为已定义服务器 id（fail-closed 拒启）、periodHours>0/graceBuckets≥0；
- `auth.js` createVerifier：校验链扩展——静态 Token → 全局 HMAC（`hmac-<桶>-<hex>`）→ 每人 HMAC（新格式 `hmacu-<id>-<桶>-<hex>`，HMAC-SHA256(个人secret, 桶号)，桶窗按个人 periodHours/graceBuckets）；通过后 tokenId = `hmacu-<id>`，从而**天然接入既有 servers 白名单与审计**（tokenServers 绑定）；
- `scripts/derive-token.js`：新增 `--id <userId>` 参数输出每人格式；无 `--id` 保持全局格式（向后兼容）；头注释更新用法；
- 弱 secret（<32 字符）启动告警（与静态 Token 告警同风格）；
- 文档：README auth 示例、使用说明 §7.1（hmacUsers 表格行 + 示例）、开发需求文档 FR5 扩展、CHANGELOG [未发布] 追加；
- 测试：test-http.js 新场景——每人 secret 派生可用且落其白名单、白名单过滤/越权拒绝、错误 secret（含用全局 secret 冒充个人 id）401、与全局 HMAC 并存。

# 非目标

- 不改全局 `auth.hmac` 行为（并存兼容）；不做管理界面；不做吊销列表（删条目即吊销）。

# 验收示例

- A1：`hmacUsers: [{id:"emp", secret:S1, servers:["srv-b"]}]`——`derive-token.js --secret S1 --id emp` 输出的 token 通过鉴权，run_command 默认落在 srv-b（结果含 `server: srv-b`），list_servers 仅见 srv-b；
- A2：错误 secret（用全局 secret + `--id emp` 冒充）→ 401；越权 `server=srv-a` → 拒绝；全局 HMAC Token（无 id 格式）行为不变，两者并存互不干扰；
- A3：配置校验：hmacUsers 缺 secret、servers 引用未定义 id、periodHours 非法 → 拒绝启动并指明条目；
- A4：文档三处 + derive-token.js `--id` 用法同步。

# 决策

- D1（用户 2026-09-24"每人一个单独的"）：每人独立 secret + 各自 servers 白名单；token 格式 `hmacu-<id>-<桶>-<hex>`（id 仅用于查找条目，非秘密；hex 部分为 HMAC-SHA256(secret, 桶号)）。
- D2：与全局 `auth.hmac` 并存（全局派生 Token 不受限的语义保留，文档已注明仅发可信调用方）。
- D3：依据既有授权免确认推进。

# 待解决问题

（无——方案在 2026-09-24 对话中已与用户对齐（"每人一个单独的"），用户指示开发。）

# 验证预期

- test-http.js 新场景全断言通过 + 既有全部回归全绿；SEA 构建通过（不部署）。
