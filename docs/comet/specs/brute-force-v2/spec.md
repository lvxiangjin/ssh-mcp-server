# Capability: brute-force-v2 —— 防爆破 v2（来源判定、双维计数、封禁策略）

本规格描述归档后 HTTP 模式防爆破的完整行为，取代既有归档 Spec（http-auth）第 2 节的防爆破章节。仅针对 `/mcp`、`/upload`、`/download` 业务端点的 401 鉴权失败计数；成功请求永不计数。所有状态保存在进程内存（重启清零），后台周期清扫过期记录防内存膨胀，零新增第三方依赖。

## 1. 来源 IP 判定

- 判定顺序：
  1. TCP 对端（`req.socket.remoteAddress`）为默认来源；
  2. 仅当 TCP 对端命中 `auth.trustedProxies`（IP/CIDR 字符串数组，CIDR 用 `node:net` 匹配）时，改采代理头：优先 `X-Real-IP`，其次 `X-Forwarded-For` 最右项（最近一层可信代理追加的地址不可伪造）；
  3. 白名单未命中时，代理头中的任何值一律忽略（伪造 `X-Real-IP`/`XFF` 不影响限速与封禁）。
- `SSH_MCP_TRUST_PROXY=1` 旧开关向后兼容：等同「信任所有对端」（等价于 `trustedProxies: ["0.0.0.0/0","::/0"]`），启动时打印弃用警告并建议改用 `auth.trustedProxies`。
- `auth.trustedProxies` 缺省为空数组 = 不信任任何代理头（默认安全侧）。非法条目（无法解析的 IP/CIDR）拒绝启动。

## 2. 双维度计数与封禁

- 计数键为二元组 `(判定来源 IP, 主体指纹)`：主体指纹为提交 Bearer 值的 `invalid-<sha256 前 8 位>`（无 Token/格式错误同为 invalid 指纹）。同一来源 IP 换 Token、同一 Token 换来源 IP，都是新的计数键。
- 滑动窗口（默认 60 秒，`auth.rateLimit.windowMs` 可调）内同一键失败 ≥ `maxFails`（默认 10）→ 封禁该键 `banMs`（默认 600 秒）。
- 同一判定 IP 跨所有键的窗口内累计失败 ≥ `maxFails × 3` → 升级封禁整个判定 IP `banMs`（防海量指纹分散试探；阈值倍数 3 固定，不引入新配置）。
- 封禁期内该键（或该 IP）的一切业务端点请求（无论凭据对错）直接 `429` + `Retry-After: <秒>`（JSON-RPC error，code -32002），不进入鉴权、不计数、**不延长封禁**；封禁到期自动解除。
- 非 401 失败原因（expired/disabled/unknown/hmac-window）与无效 Token 一视同仁计数。

## 3. 管理网段豁免

- `auth.banAllowlist`（IP/CIDR 数组，缺省空 = 无豁免）：判定来源命中时该请求**永不计数、永不 429**（无论失败多少次），防管理网段被攻击者连带封禁自我锁死；非法条目拒绝启动。

## 4. 参数校验

`auth.rateLimit.windowMs/maxFails/banMs` 须为 ≥1 的数（沿现状）；`trustedProxies`/`banAllowlist` 须为字符串数组；违规拒绝启动。计数仅对业务端点生效，扫描器打其他路径的 401 不消耗失败额度（沿现状）。

## 场景

Scenario: 伪造代理头不影响计数
`trustedProxies` 为空时，同一来源以随机 `X-Real-IP`/`X-Forwarded-For` 发送 20 次错误 Token，全部 401 且不触发 429（按 socket IP 计数未达单键阈值 10 之外的升级线除外——20 次同键仍会封禁；本场景以「伪造头轮换 20 个不同 X-Real-IP」验证不产生 20 个独立计数键，封禁判定与不带伪造头时完全一致）。
验收：A2

Scenario: 白名单对端采信代理头
TCP 对端在 `trustedProxies` 内时，携带 `X-Real-IP: 10.1.1.5` 的失败计数计入 10.1.1.5；对端不在白名单时同样请求计入 socket 对端。
验收：A2

Scenario: 双维度封禁与解除
同一 IP+同一错误 Token 在窗口内失败达到 maxFails → 封禁生效（正确 Token 同键也 429）；等待 banMs 到期后自动解除；封禁期内继续发送失败请求不延长封禁时长。
验收：A3

Scenario: 正确 Token 永不计数
持续使用正确 Token 请求任意次，无任何 429。
验收：A3

Scenario: 豁免网段
`banAllowlist` 命中的来源发送超过阈值的大量失败请求，永不 429。
验收：A3
