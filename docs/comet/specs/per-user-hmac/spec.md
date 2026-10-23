# Capability: per-user-hmac —— 每人独立 HMAC secret

## 1. 配置

`auth.hmacUsers[]`：每条 `{ id, secret, servers?, periodHours?, graceBuckets? }`：
- `id`：须匹配 `[a-z0-9_-]+`（用于 token 格式与查找）；
- `secret`：必填非空字符串（<32 字符启动告警）；
- `servers`：可选，服务器 id 白名单（语义同 auth.tokens[].servers：缺省/空数组 = 不限；引用未定义 id = 拒绝启动）；
- `periodHours`/`graceBuckets`：可选，缺省 24h / 1（不继承全局 `auth.hmac` 的设置）。

## 2. Token 格式与校验

- 每人格式：`hmacu-<id>-<桶>-<hex>`，`hex = HMAC-SHA256(个人secret, 桶号十进制串)`；
- 校验链顺序：静态 Token → 全局 `hmac-<桶>-<hex>` → 每人 `hmacu-…`；任一命中即通过；
- 通过后 tokenId = `hmacu-<id>`，天然接入既有 servers 白名单（tokenServers 绑定）、审计与防爆破；
- 全局 `auth.hmac` 行为不变（并存）。

## 3. 派生脚本

`scripts/derive-token.js` 新增 `--id <userId>`：输出每人格式；无 `--id` 输出全局格式（向后兼容）。

## 4. 安全

- 每条 secret 独立：泄露一人 secret 仅影响其白名单范围；吊销 = 删除其 hmacUsers 条目；
- 弱 secret（<32 字符）启动告警；servers 引用未定义 id 拒绝启动。
