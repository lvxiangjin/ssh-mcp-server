# 更新日志（CHANGELOG）

所有对外可见的变更记录于此。版本号与 `package.json` / MCP Server 元数据保持一致。

## [0.4.1] — 2026-10-21

### 安全
- 移除 `X-Powered-By: Express` 响应头（`app.disable("x-powered-by")`），不向探测方暴露框架指纹。

### 测试
- test-http.js 完整流程块的防爆破断言不再随仓库 config.json 的 `auth.banAllowlist` 豁免配置漂移（克隆配置强制清空豁免网段），修复 Verifier 验收时标记的恒红断言。

## [0.4.0] — 2026-10-21

生产从 [0.3.0] 升级（SEA 单文件部署于 10.0.0.11）。含 main 分支已积累的存量能力与本版安全改造。

### 新增
- **内置可选 TLS**：`SSH_MCP_TLS_CERT`/`SSH_MCP_TLS_KEY`（或 config `tls` 段）配置后以 HTTPS 监听，全端点加密；未配置保持 HTTP 现状（完全向后兼容）；配套 `scripts/gen-cert.sh` 自签证书生成（EC P-256，SAN 自动收录本机 IP，私钥 0600）；
- **高危命令二次确认**：`run_command` 新增 `confirm` 参数与内置 `auth.confirmPatterns` 确认清单（rm -rf 变体、mkfs、dd 写盘、shred、`find / -delete`、重定向系统关键文件等）——命中默认拒绝并返回命中说明与指引，`confirm: true` 复核后执行；黑名单继续兜底且优先（命中黑名单即使 confirm 也硬拒）；显式配置 `auth.confirmPatterns` 即完全覆盖默认清单；
- **Token 文件化存储**：`SSH_MCP_TOKEN_FILE` 从私有权限文件读取 Token（首行、去空白），与 `SSH_MCP_TOKEN` 互斥；group/other 可写、文件缺失/为空拒绝启动，非 0600 打警告；部署样例改 `EnvironmentFile`；
- **防爆破代理白名单**：`auth.trustedProxies`（IP/CIDR）——仅当 TCP 对端命中白名单才采信 `X-Real-IP`/`X-Forwarded-For`（取最右项），伪造代理头无法再绕过限速；`SSH_MCP_TRUST_PROXY=1` 兼容为「信任所有对端」并打弃用警告；
- **封禁豁免网段**：`auth.banAllowlist`（IP/CIDR）命中永不计数、永不 429，防管理网段被攻击者连带封禁自我锁死；
- **后台任务**：`run_command` 新增 `background` 参数（目标机 nohup 执行，状态文件落目标机、网关重启不丢）与 `cwd` 工作目录参数；新增 `check_job`（状态/退出码/输出尾部，自动清理 7 天前旧任务）与 `kill_job` 工具；
- **大文件流式下载 `GET /download`**：与 `/upload` 对称的下载端点（不限大小、恒定内存、响应头 `X-Md5`/`X-File-Size` 先行），`download_stream` 审计条目全覆盖；
- **Token 级服务器访问控制**：`auth.tokens[].servers` 白名单——限定每个 Token 只能访问指定服务器（`list_servers` 过滤、工具与流式端点全量强制、越权拒绝不泄露目标机信息、默认目标优先取全局 defaults.serverId（在白名单内），否则取白名单首个；list_servers 的 [默认] 标注与实际解析一致），实现"管理员/普通员工"分级授权；引用未定义 id 时拒绝启动。
- **每人独立 HMAC（`auth.hmacUsers[]`）**：各自 secret + 各自服务器白名单 + 各自轮换周期——token 每天自动变（格式 `hmacu-<id>-<桶>-<hex>`），泄露一人只影响其自身范围；`derive-token.js --id` 派生；弱 secret 告警、非法配置拒绝启动。

### 改进
- **防爆破升级为双维计数**：失败计数与封禁按「来源 IP + 提交凭据指纹」二元组——换 Token 或换 IP 单独轮换均无法绕过；同一 IP 跨凭据累计失败达 `maxFails×3` 升级封禁整个 IP；封禁期内请求不计数、不延长封禁（沿现状）；
- `run_command` 输出截断改为**保留头部 60% + 尾部 40%** 并标注省略字节数（命令开头回显与结尾报错同时可见）；
- 审计条目新增 `result` 返回结果摘要（头 1024 + 尾 256 字符，`audit.resultChars` 可调、`0` 关闭）；
- 审计入参白名单补 `background/cwd/job_id/tail_lines/confirm`。

### 依赖
- `@modelcontextprotocol/sdk` ^1.12 → ^1.32、`express` ^4.21 → ^5.3（大版本，含路由/错误处理适配）、`ssh2` ^1.16 → ^1.17；
- `package.json` 声明 `engines: node >=22`（与 SEA 构建环境一致）。

### 安全
- **修复黑名单引号绕过**：`bash -c "rm -rf /"` 类引号/包裹变体 0.3.x 正则会漏判，现由内置最低限度黑名单兜死（与 config 黑名单合并生效，不依赖部署方 config 更新）；
- 默认黑名单新增：`dd of=/dev/sd*`（磁盘覆写变体）与 `chmod -R 777 /`；
- 新增 `scripts/setup-limited-user.sh`：一键在目标机创建 AI 专用低权限账号（sudoers 强制 `--no-pager` 防分页器逃逸）；
- 后台任务防 /tmp 目录符号链接与属主接管；`kill_job` 防 PID 复用误杀；
- **SSH 主机指纹校验**：服务器配置加 `hostFingerprint`（SHA-256 格式），防中间人攻击；
- **路径规范化**：文件工具仅接受绝对路径，处理 `..`/重复斜杠，并在目标机解析符号链接真实路径；可选 `allowedFileRoots` 限定文件操作目录；
- **上传原子覆盖**：先写临时文件再 rename，中断不毁原文件；
- **SSH 并发上限**：最多同时 10 个 SSH 连接（防止资源耗尽）；
- **启动校验**：重复 server id、重复 token id、错误 default server、非法 max*Bytes 均拒绝启动。
- **二进制识别**：下载内容通过严格 UTF-8 解码判定文本，非法 UTF-8 即以 base64 返回，避免无 NUL 二进制被替换损坏。

## [0.3.0] — 2026-09-21

当前正式版本（生产部署于 10.0.0.11，SEA 单文件包）。

### 新增
- **HTTP 鉴权体系**（多 Token / HMAC 派生自动轮换 / 防爆破 / 审计日志）：
  - `auth.tokens[]`：多静态 Token，按 `id` 区分身份，支持 `expiresAt` 过期与 `disabled` 禁用，轮换新旧并存；
  - `auth.hmac`：派生 Token 按时间桶自动轮换（默认按天、宽容 ±1 桶），两端只存 master secret，配套 `scripts/derive-token.js`；
  - 防爆破：鉴权失败限速 + 连续失败封禁来源 IP（429 + Retry-After）；`SSH_MCP_TRUST_PROXY` 适配反代取真实 IP；
  - 审计日志：`audit.enabled` 开启后 JSONL 按天落盘（命令全文、Token 身份、来源 IP；不记文件内容与 Token 原值）；
  - 鉴权失败统一 401 不泄露凭据状态；完全向后兼容旧 `SSH_MCP_TOKEN` 单 Token 部署。
- **大文件流式上传 `POST/PUT /upload`**：
  - 请求体直达目标机 SFTP，网关恒定内存；默认上限 3GiB（`defaults.maxStreamUploadBytes` 可配）；
  - 实测 3GiB 上传 99s（32.5MB/s）、远端 md5 一致；超限/中断自动清理远端残片；
  - 返回远端实测 md5；复用 Bearer 鉴权、防爆破与审计。

### 修复
- HTTP 模式 MCP 上传被 `express.json` 默认 100KB 请求体限制挡住（上限现与 `maxUploadBytes` 挂钩，JSON 解析收窄到 /mcp）；
- `mode` 参数 chmod 八进制 bug（`0600` 被转十进制导致 chmod 必然失败）；
- `md5sum` 失败不再伪装上传成功；
- SFTP 写缓冲 highWaterMark 提到 4MB（流式上传从 ~2MB/s 提升到数十 MB/s）；
- `scripts/build-linux.sh` 在 Windows 检出下被 CRLF 损坏（新增 `.gitattributes` 钉住 `*.sh` 为 LF）。

### 部署
- 单文件 SEA 包：`bash scripts/build-linux.sh` → `dist/ssh-mcp-server-linux`（构建环境：WSL Ubuntu / Node 22）；
- 生产产物固化于 `10.0.0.11:/opt/ssh-mcp/releases/`（含 SHA256SUMS）；回滚：从 releases 拷回对应版本并 `systemctl restart ssh-mcp`；
- 详见 `docs/使用说明.md` §6.5（大文件上传）、§7.1–7.3（鉴权与审计）。

## [0.1.0] — 2026-09-21

- 首个可用版本：SSH MCP 网关（run_command / upload_file / download_file / list_servers）、危险命令与敏感路径黑名单、stdio + HTTP 双传输、SEA 单文件打包部署。
