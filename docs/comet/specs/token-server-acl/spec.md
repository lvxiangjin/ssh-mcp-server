# Capability: token-server-acl —— Token 级服务器访问控制

## 1. 配置

- `auth.tokens[].servers`：可选字符串数组，元素为 config.servers 的 id；
- 缺省（字段不存在或空数组）= 不限（可用全部服务器）——向后兼容；
- 校验：数组元素必须引用已定义的服务器 id，否则网关拒绝启动并指明 token 与 id；
- env Token（SSH_MCP_TOKEN）不受限。

## 2. 强制点

| 位置 | 行为 |
|---|---|
| list_servers | 受限 Token 仅返回白名单内服务器（不泄露其余存在） |
| 四工具 + 后台任务 `server` 参数 | 白名单外 → 拒绝：`无权访问指定的服务器`（isError，不泄露目标机信息） |
| 默认服务器解析（未传 server） | 受 Token 影响：全局 defaults.serverId 在该 Token 白名单内时取全局默认，否则取白名单第一个；不受限 Token 取全局 defaults.serverId。`list_servers` 的 [默认] 标注与实际解析一致 |
| GET /download、POST/PUT /upload 的 `server` 参数 | 同上强制，越权 `403 {"error":"无权访问指定的服务器"}` |

## 3. 审计

- 越权尝试：审计条目 error 记录拒绝信息（不含目标机信息），args.server 留痕被请求的服务器 id；token 身份照常记录。

## 4. 兼容

- stdio 模式无 Token 体系，不受影响；env 单 Token 旧部署行为完全不变；未配置 servers 字段的 Token 行为完全不变。
