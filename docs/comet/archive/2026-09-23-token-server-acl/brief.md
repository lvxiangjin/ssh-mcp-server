# 目标

为 HTTP 模式实现 Token 级服务器访问控制：`auth.tokens[]` 每个 Token 可绑定 `servers` 白名单，限定该角色（调用方）能访问哪些目标服务器——list_servers 只见白名单、工具执行与上传/下载端点全量强制、越权拒绝并审计。**纯开发，不触碰 1.6 生产**（部署与账号建设由使用者择机进行）。

# 范围

- `auth.tokens[]` 新增可选 `servers: [id]` 字段（缺省 = 不限，向后兼容）；配置校验：引用不存在的服务器 id → 拒绝启动（fail-closed）。
- 强制点（全端点）：
  - `list_servers`：受限 Token 只见白名单内服务器（不泄露其他服务器的存在）；
  - 四个工具 + 后台任务的 `server` 参数与默认服务器解析：受限 Token 的默认目标 = 白名单第一个（绝不落到全局默认）；显式指定白名单外 → 拒绝（提示不含该服务器是否存在）；
  - `GET /download` 与 `POST/PUT /upload` 的 `server` 参数：同样强制，越权 403；
- 拒绝统一文案"无权访问指定的服务器"（不泄露目标机信息），审计记录 `server-acl:<requested>`；
- env 旧 Token 与未配置 `auth` 的部署行为不变（不受限）。
- 文档：README 配置示例、使用说明 §7.1（tokens 字段表 + 分级示例：admin 绑 root 条目、员工绑 aiops 条目）、开发需求文档 FR4 扩展或新增 FR10、CHANGELOG [未发布] 追加。
- 测试：双服务器条目（同一真实主机、不同 id）场景覆盖受限/不限/越权/默认解析/端点。

# 非目标

- 不实现完整 role 档位系统（命令白名单、工具级差异）——后续规划；
- 不改 stdio 模式（无 Token 即无限制，不变）；
- 不做目标机账号建设自动化（setup-limited-user.sh 已有）；
- 不部署 1.6（用户明确要求）。

# 验收示例

- A1（受限视角）：Token 绑定 `[srv-a]` 后：list_servers 仅见 srv-a；run_command 不传 server 默认落在 srv-a；check_job/kill_job/upload_file/download_file 同样只能用 srv-a。
- A2（越权拒绝）：受限 Token 显式 `server=srv-b`：run_command 返回"无权访问指定的服务器"（isError）、/upload 与 /download 返回 403、审计记录 server-acl 拒绝；srv-b 的存在与否无法从响应判断。
- A3（向后兼容）：无 servers 字段的 Token 与 env 旧 Token 行为完全不变（全部服务器可用、默认解析不变）；stdio 模式不受影响。
- A4（配置校验）：token.servers 引用未定义的服务器 id → 网关拒绝启动并指明哪一条。

# 决策

- D1（用户 2026-09-23 明确需求"控制角色能访问哪个服务器"+"不动 1.6 纯开发"）：以 Token 级 servers 白名单实现，字段名 `servers`；受限 Token 的默认服务器取白名单首个（防落到全局默认的越权）。
- D2：拒绝响应统一"无权访问指定的服务器"，不泄露服务器存在性；审计记录被请求的 id（内部可见）。
- D3：env Token 与无 `servers` 字段的 Token 不受限（向后兼容）；stdio 不变。
- D4：用户已授权全程免确认推进。

# 待解决问题

（无。）

# 验证预期

- test-http.js 新增双服务器场景（同一真实主机两个 id）：A1-A4 全覆盖断言；既有 64 项断言回归全绿。
- SEA 构建通过（仅验证打包，不部署）。
