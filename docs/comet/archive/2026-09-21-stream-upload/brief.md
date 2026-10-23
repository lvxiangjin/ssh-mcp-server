# 目标

让网关具备大文件传输能力：新增 HTTP 流式上传端点（POST/PUT `/upload`），默认上限 3GiB（可配），服务端恒定内存、远端落盘后返回 md5 校验；同时修复 MCP base64 上传在 HTTP 模式下被 `express.json` 默认 100KB 请求体限制挡住的问题。

背景约束（决定方案形态）：MCP 工具调用走 JSON-RPC，3GB 文件会变成约 4GB 的 base64 字符串，超出 V8 字符串长度上限且需要数十 GB 瞬时内存——**经 MCP 直传 3GB 在协议上不可行**。因此大文件走网关专属流式端点，MCP 的 `upload_file` 保持中小文件定位。

# 范围

- `lib.js`：新增 `uploadFileStream(serverCfg, remotePath, req, maxBytes, mode)`——HTTP 请求体流式管道到 SFTP 写入流（不缓存全量内容）；超限中止并删除远端半截文件；完成后远端 `md5sum` 校验；客户端中断同样清理。
- `server.js`：
  - 新增 `/upload` 路由（POST/PUT），查询参数 `path`（必填，绝对路径）、`server`（可选）、`mode`（可选八进制权限）；复用 Bearer 鉴权、防爆破与审计中间件（401 计入限速、审计记 `upload_stream` 条目）；
  - `express.json` limit 与 `defaults.maxUploadBytes` 挂钩（修复默认 100KB 限制）；
  - `server.requestTimeout = 0`（大文件上传不受 Node 默认 300s 请求超时影响）；
  - 启动日志打印流式上传上限；`upload_file` 工具描述指引大文件改用 `/upload`。
- `lib.js` defaults：新增 `maxStreamUploadBytes`，默认 `3 * 1024 ** 3`（3GiB），config.json 可配。
- 文档：README（功能/配置示例/大文件上传小节/Nginx client_max_body_size 说明）、`docs/使用说明.md`（§6.5 大文件上传 + §7.6 资源限制）、`docs/开发需求文档.md`（FR8 + NFR1 + 后续规划加断点续传）。
- 测试：`test-http.js` 覆盖 A1–A5 可自动化部分。

# 非目标

- 断点续传、分块并行、传输压缩（记入后续规划）。
- 下载侧流式改造（`download_file` 现有上限与行为不变）。
- 经 MCP 直传大文件（协议不可行，见上）。
- /upload 不支持目录、不支持覆盖前确认（同 upload_file 语义：直接写）。

# 验收示例

- A1（流式上传全流程）：对可达服务器的网关，POST 8MB 随机数据到 `/upload?path=/tmp/x.bin`，返回 200 `{ok:true, bytes, md5}` 且 bytes/md5 与本地计算一致；`mode=0600` 生效。
- A2（鉴权与审计）：错误 token 调 `/upload` 返回 401 且计入防爆破失败数；成功/失败调用在审计中产生 `tool:"upload_stream"` 条目（含 bytes，不含文件内容）。
- A3（上限控制）：`Content-Length` 超过 `maxStreamUploadBytes` 即刻 413（不建立 SSH 连接）；流中超限返回 413 且远端半截文件被清理（不留残片）。
- A4（MCP 路径修复）：HTTP 模式下经 `upload_file` 上传 200KB 文件（JSON 请求体约 273KB > 旧默认 100KB 限制）成功。
- A5（文档与配置）：`maxStreamUploadBytes`、curl 示例、Nginx 说明写入三份文档；FR8 入开发需求文档。

# 约束与不变量

- 零新增 npm 依赖；服务端上传过程内存占用恒定（流式管道，不落网关磁盘、不全量缓存）。
- `/upload` 复用 /mcp 的 Bearer 鉴权、封禁、审计体系；`/healthz` 不变。
- 上传语义与 `upload_file` 一致：目标路径绝对路径、自动创建父目录、覆盖写、mode 可选。
- 审计不记录文件内容；记录路径、字节数、md5、身份、IP。

# 决策

- D1（用户 2026-09-21 提出"上传调大到 3GB"）：经 MCP 直传 3GB 协议不可行（4GB base64 字符串超 V8 上限），故采用网关流式 HTTP 端点方案；MCP 上传定位保持中小文件。依据用户此前授权（全程免确认推进）直接实施。
- D2：默认上限 3GiB 写入 `defaults.maxStreamUploadBytes`，config.json 可调（含调更大）。
- D3：`express.json` limit 按 `maxUploadBytes*1.4+256KB` 动态计算，MCP 路径不再被 100KB 默认值卡死。
- D4：`server.requestTimeout = 0`，上传时长不受 Node 默认 300s 约束；慢速头攻击仍由 headersTimeout（60s 默认）防护。

# 待解决问题

（无——方案形态由协议约束唯一确定，用户已授权免确认推进。）

# 验证预期

- `node test-http.js` 全绿（含 A1 8MB 流式上传 md5 比对、A4 200KB MCP 上传、A3 413、A2 401）。
- 实机（10.0.0.11）部署后执行真实 3GiB 文件上传，比对两端 md5。
