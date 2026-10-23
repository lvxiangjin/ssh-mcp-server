# Capability: http-auth —— HTTP 模式鉴权与防护

本规格描述归档后 ssh-mcp-server HTTP 传输模式的完整鉴权、防爆破与审计行为。stdio 模式不在此capability 范围内（保持现状：本机进程边界保护，无鉴权）。

## 1. 凭据模型

### 1.1 凭据来源（三者并存）

客户端一律通过 `Authorization: Bearer <value>` 提交凭据。服务端接受以下三类来源，任一匹配即通过：

1. **环境变量静态 Token**：`SSH_MCP_TOKEN`（若设置），固定身份 `env`。保持向后兼容。
2. **多静态 Token**：`config.json` 的 `auth.tokens[]`，每项 `{id, token, expiresAt?, note?, disabled?}`：
   - `id`：调用方身份标识，用于审计与服务端日志；
   - `expiresAt`：ISO 8601 时间，超过该时刻的 Token 视为不存在（自动失效，无需重启）；
   - `disabled: true`：等同不存在；
   - `note`：备注，仅运维参考。
3. **HMAC 派生 Token（自动轮换）**：`auth.hmac` 段 `{secret, periodHours?, graceBuckets?}` 存在时启用：
   - Token 形如 `hmac-<bucket>-<hex>`；
   - `bucket = floor(unixTimestamp秒 / (periodHours × 3600))`，`periodHours` 默认 24；
   - `hex = HMAC-SHA256(secret, 十进制桶号字符串).digest('hex')`（消息就是桶号的十进制字符串，如 `"20341"`）；
   - 接受窗口：`bucket ∈ [current − graceBuckets, current + graceBuckets]`（闭区间），`graceBuckets` 默认 1；
   - hex 必须全程常量时间比较（`crypto.timingSafeEqual`）。

`expiresAt` 存在但无法解析时，该 Token 按已过期处理（fail-closed），并打启动警告——绝不允许因格式笔误把应吊销的 Token 变成永不过期。`auth.hmac.periodHours`（须 >0）、`auth.hmac.graceBuckets`（须 ≥0）、`auth.rateLimit.*`（须为正数）配置非法时网关拒绝启动。

### 1.2 校验规则

- 校验顺序不影响结果；任一匹配即通过，身份取匹配项的 `id`（HMAC 派生 Token 身份固定为 `hmac`）。
- 过期、禁用、不存在的 Token 与 HMAC 桶越界，对外响应完全相同：`401` + JSON `{"jsonrpc":"2.0","error":{"code":-32001,"message":"unauthorized"},"id":null}`。不得从响应区分失败原因。
- 失败原因诊断（unknown / expired / disabled / hmac-out-of-window）只写入服务端 stderr 日志与审计记录（指纹形式）。
- Token 原值与 HMAC secret 不得出现在任何日志、审计与响应中；审计中 Token 以 `id` 标识，鉴权失败以 `invalid-<sha256前8位>` 指纹标识。

### 1.3 启动行为

- HTTP 模式下，若 `SSH_MCP_TOKEN`、`auth.tokens`、`auth.hmac` 三者均未配置：拒绝启动（保持现状），错误信息提示设置任一凭据来源。
- 任一凭据来源存在即可启动；启动日志打印：监听地址、静态 Token 数量（不含值）、HMAC 是否启用及参数、当前服务端时间桶号、桶号对应 UTC 时间（便于核对时钟漂移）。
- 静态 Token 长度 < 32 个十六进制字符（即非 `openssl rand -hex 32` 量级）时打启动警告，不拒绝启动。

## 2. 防爆破（限速与封禁）

- 仅针对 `/mcp` 端点的 **401 鉴权失败**计数；成功请求不计数。非 `/mcp` 路径的 401 仍返回统一 401，但不计数、不进审计（扫描器打其他路径不应耗尽共享出口 IP 的失败额度）。
- 内存滑动窗口，默认：60 秒窗口内同来源 IP 失败 ≥ 10 次 → 封禁该 IP 600 秒。可通过 `auth.rateLimit: {windowMs?, maxFails?, banMs?}` 覆盖。
- 封禁期内该 IP 的所有 `/mcp` 请求（无论凭据对错）直接返回 `429` + `Retry-After: <秒>`（JSON-RPC error 格式，code -32002），不进入鉴权与 MCP 处理。
- 来源 IP 判定：`SSH_MCP_TRUST_PROXY=1` 时依次取 `X-Real-IP`、`X-Forwarded-For` 首项；否则取 TCP 连接 IP。默认不信任代理头（防伪造绕过）。
- 计数与封禁状态保存在进程内存：重启清零；后台周期清理过期计数防内存膨胀；封禁到期自动解除。
- `127.0.0.1` 不豁免（反代场景所有请求的连接 IP 都是本机，豁免会架空封禁；封禁按判定的来源 IP 生效）。

## 3. 审计日志

- 配置：`config.json` 的 `audit: {enabled: boolean, dir?}`。**默认关闭**；`enabled: true` 才启用。`dir` 默认 `<进程工作目录>/logs`，目录不存在时自动创建。
- 开启后，HTTP 模式下以下事件各写一条 JSONL 到 `<dir>/audit-YYYY-MM-DD.log`（按天分文件，UTC 日期）：
  - **工具调用**（鉴权成功后的 `/mcp` 请求）：`{ts, ip, tokenId, tool, args, ok, error?}`。`args` 记录参数全文：`command` 全文、`remote_path`、`server`、`timeout_ms`、`max_bytes` 等；**不记录** `content_base64` 与下载内容。
  - **鉴权失败**：`{ts, ip, tokenId: "invalid-<指纹8位>", tool: null, args: null, ok: false, error: "auth-failed:<原因>"}`。原因仅 internal 级别（unknown/expired/disabled/hmac-window）。
- `/healthz` 请求与 429 封禁拒绝**不产生**审计记录。
- 审计目录无法创建（权限/只读盘）时拒绝启动（配置错误早暴露）；运行期写失败不阻断业务，stderr 告警（限频：每分钟至多一条）。
- 日志写入为追加单行 JSON；不做轮转压缩（按天分文件已可控体积），删除归档交运维。

## 4. 兼容与迁移

| 现有部署形态 | 升级后行为 |
| --- | --- |
| 仅 `SSH_MCP_TOKEN` | 完全不变：正确 Token 通过（身份 `env`），错误/缺失 401，缺失 Token 拒绝启动 |
| 无任何凭据 | 拒绝启动（不变） |
| stdio 模式 | 完全不变，无鉴权 |
| 新增 `auth` 段 | env Token 与 config Token 并存生效 |

## 5. 配套脚本

- `scripts/gen-token.js`：输出 64 位十六进制强随机 Token（`crypto.randomBytes(32)`），供 `auth.tokens[].token` 与 `SSH_MCP_TOKEN` 使用。
- `scripts/derive-token.js`：`--secret <master>` 必填，`--period-hours`、`--at <ISO时间>`、`--offset <n>` 可选；输出对应时刻的 `hmac-<bucket>-<hex>`，与网关校验逻辑同一实现（共享 lib 函数），保证两端一致。
- 文档（`docs/使用说明.md`）附 cron/systemd timer 每日轮换示例，并如实说明客户端静态 header 的适配方式与局限（客户端需重读配置/重启生效；不适合时可拉长 `periodHours`）。

## 6. 文档同步

- `docs/使用说明.md`：安全配置章节扩写多 Token、HMAC 派生 Token 与轮换、限速封禁、审计日志的配置说明与环境变量表（新增 `SSH_MCP_TRUST_PROXY`）。
- `docs/开发需求文档.md`：FR5 扩展为覆盖多 Token/派生 Token/防爆破/审计；非目标中移除"不内置审计日志"（改为"不做审计落库与检索"）；后续规划相应调整。
