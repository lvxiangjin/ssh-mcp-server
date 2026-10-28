# 目标

完成 ssh-mcp-server v0.4.0 版本升级改造：将 main 分支已积累、生产尚未发布的存量能力正式定版（当前生产运行 0.3.0），并按 2026-10-21 安全覆盖复审结论补齐安全改造（TLS 传输加密、防爆破 v2、高危命令二次确认、Token 存储卫生），同步升级落后依赖（MCP SDK 1.12→1.32、ssh2 1.16→1.17），最终以 SEA 单文件发布并部署 10.0.0.11 完成冒烟验证。

# 范围

1. **发版收尾（存量定版）**：`package.json` 0.3.0→0.4.0；CHANGELOG「未发布」段归并为 `[0.4.0]`（后台任务、`/download` 流式下载、Token 服务器 ACL、per-user HMAC、主机指纹校验、上传原子覆盖、SSH 并发上限、启动校验等既有存量）；SEA 构建；git tag `v0.4.0` + SHA256SUMS + releases 归档；10.0.0.11 部署冒烟。
2. **TLS 传输加密（内置可选）**：配置证书后以 HTTPS 监听（`SSH_MCP_TLS_CERT`/`SSH_MCP_TLS_KEY` 或 config `tls` 段）；未配置时保持 HTTP 现状（向后兼容）；提供自签证书生成脚本；反代场景维持「HTTP + 代理头」方案并在文档写明取舍。
3. **防爆破 v2**：
   - 信任代理白名单化：新增 `auth.trustedProxies`（IP/CIDR 数组），仅当 TCP 对端命中白名单才采信 `X-Real-IP`/`X-Forwarded-For`（取最右项）；`SSH_MCP_TRUST_PROXY=1` 旧开关兼容为「信任所有对端」并打弃用警告；
   - 计数维度升级：鉴权失败计数与封禁按「判定来源 IP + 认证主体指纹」双维度，换 IP 或换 Token 单独轮换均无法绕过；
   - 封禁策略：封禁期内请求不延长封禁（保持现状）；新增 `auth.banAllowlist`（网段数组）永不封禁，防管理网段自我锁死；封禁时长支持上限封顶。
4. **高危命令二次确认**：新增 `auth.confirmPatterns`（正则数组，默认覆盖 rm -rf 变体、mkfs、dd 磁盘写入、shred、find -delete、重定向覆盖系统文件等）；`run_command` 命中时默认拒绝并返回命中说明与确认方式，同一会话带 `confirm: true` 重试才执行；既有 `blockedCommandPatterns` 黑名单继续兜底；修复现有正则的引号绕过（如 `bash -c "rm -rf /"`）。
5. **Token 存储卫生**：支持 `SSH_MCP_TOKEN_FILE`（要求 0600 权限的文件读取 Token）；部署样例从 systemd 内联 `Environment=` 改为 `EnvironmentFile`；补充 Token 轮换 runbook。
6. **依赖升级**：`@modelcontextprotocol/sdk` ^1.12→^1.32、`ssh2` ^1.16→^1.17、express 大版本 ^4.21.2→^5.3.0（完成破坏性变更适配：path-to-regexp v8 路由语法、异步错误处理语义等，全量回归）；`package.json` 补 `engines: node >=22`。
7. **文档同步**：使用说明（TLS、新配置段、部署清单）、开发需求文档（FR5/NFR2 更新）、CHANGELOG。

## 目录结构

### 新建

- specs/tls-http/spec.md — HTTPS 可选监听的完整行为规格
- specs/brute-force-v2/spec.md — 防爆破 v2（代理白名单/双维计数/封禁策略）规格
- specs/command-confirmation/spec.md — 高危命令二次确认规格
- specs/token-storage/spec.md — Token 文件化存储规格
- scripts/gen-cert.sh — 自签证书生成辅助脚本

### 修改

- server.js — 启动段 HTTPS 监听分支；`clientIp` 代理白名单判定（约 L438）；`/mcp` 鉴权中间件接入双维计数与确认流（约 L462-500）；express 5 路由与错误处理适配
- auth.js — `createRateLimiter` 双维度状态（约 L318）；`trustedProxies`/`banAllowlist`/`confirmPatterns` 配置解析与校验
- lib.js — confirmPatterns 匹配器与确认参数处理
- config.json — 新配置段示例与注释
- package.json — 版本 0.4.0、依赖升级（express ^5.3.0）、engines
- CHANGELOG.md、docs/使用说明.md、docs/开发需求文档.md — 定版与新特性文档

### 删除

无

### 明确不建

- 不建 Web 管理面板、审计数据库、审批平台、PTY 会话——维持「后续规划」后置
- 不引入新的第三方运行时依赖——TLS、CIDR 匹配、限流、二次确认全部用 Node 内置模块实现
- 不更换打包形态（保持 SEA 单文件）与 1.6 现网 nginx 拓扑

# 非目标

- 不做开发需求文档「7. 后续规划」任何条目（审计检索落库、审批流、PTY、增量同步、断点续传、Web 面板、HMAC 备用方案推广）
- 不做 stdio 模式鉴权（维持本机进程边界保护现状）
- 不修改既有归档 Spec 的历史文件；冲突以本 change 的完整目标 Spec 为准

# 验收示例

- A1（TLS）：配置证书与私钥后网关以 HTTPS 监听，TLS 握手成功、明文 HTTP 请求被拒；不配置时行为与现状完全一致（HTTP）。
- A2（代理白名单）：TCP 对端不在 `trustedProxies` 时伪造 `X-Real-IP`/`X-Forwarded-For` 不影响限速计数（按 socket IP 判定）；对端在白名单时按代理头最右项判定。
- A3（防爆破 v2）：正确 Token 请求永不计数；错误 Token 按「来源 IP + 主体指纹」双维计数触发封禁；封禁到期自动解除且封禁期内请求不延长封禁；`banAllowlist` 网段永不 429。
- A4（高危确认）：命中 `confirmPatterns` 的命令（含 `bash -c "rm -rf /"` 引号变体）默认拒绝并返回命中说明；带 `confirm: true` 重试可执行；未命中命令不受影响；黑名单命中即使 confirm 也硬拒。
- A5（Token 文件）：`SSH_MCP_TOKEN_FILE` 读取 0600 文件中的 Token，鉴权行为与内联环境变量一致；与内联并存、文件缺失或权限异常时拒绝启动并明确提示。
- A6（依赖升级回归）：SDK ^1.32、ssh2 ^1.17、express ^5.3 升级适配后 `test-http.js`、`test-mcp.js`、`test-direct.js` 全部通过。
- A7（发布冒烟）：v0.4.0 SEA 构建成功；git tag + SHA256SUMS + releases 归档齐全；10.0.0.11 部署后 `/healthz` 200、正确/错误 Token 200/401、上传下载 md5 一致、`list_servers` 正常。

# 决策

D1：范围取全量改造——存量定版 + TLS + 防爆破 v2 + 高危命令确认 + Token 存储 + 依赖升级，一次性清零复审发现的问题（2026-10-21 用户选定）。
D2：express 大版本升 5.3（用户选定激进路线，接受适配成本），非 4.x 保守升级。
D3：TLS 采用内置可选 HTTPS（零新增依赖，单文件部署友好），nginx 反代仅作为文档化部署形态保留。
D4：高危命令采用二次确认流（confirmPatterns + confirm:true 重试），不做纯白名单；黑名单继续兜底。

# 待解决问题

无

# 验证预期

`test-http.js` / `test-mcp.js` / `test-direct.js` 全绿；SEA 构建通过；10.0.0.11 部署冒烟覆盖 A1-A7 场景。
