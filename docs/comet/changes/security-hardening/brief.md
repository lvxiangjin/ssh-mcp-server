# 目标

对 SSH 网关进行上线前安全加固与可靠性修复：消除 SSH 中间人攻击风险、防止文件传输损坏目标文件、修复流式下载的进程稳定性缺陷、限制文件操作路径范围——配合已有的 Token 鉴权 / IP 白名单 / Nginx HTTPS，使项目可安全用于管理公网服务器。

# 范围

1. SSH 主机指纹校验
2. 上传原子覆盖
3. 下载超时异常修复
4. 路径规范化与 allowedFileRoots
5. 推荐完善（并发上限/二进制检测/启动校验/test-direct 修复）
6. 文档同步

# 非目标

不做 OAuth / Redis / 数据库 / 多租户权限系统 / 复杂 HMAC 轮换平台。

# 验收示例

A1：配置 hostFingerprint 后连接正确主机成功、冒充主机被拒；不配置则跳过（向后兼容）。
A2：上传中断 → 原文件不变、残片清理；完成 → rename 后文件完整。
A3：SFTP 停滞 5min → 安全关闭不崩溃。
A4：路径 .. 逃逸 → 拒绝；不在 allowedFileRoots → 拒绝；未配置 = 不限。
A5：并发 > 10 → 排队等待；启动时重复 server id / 重复 token id / 错误 default server → 拒绝启动。
A6：test-direct.js 不再硬编码 wsl。

# 决策

D1：hostFingerprint 使用 SHA-256 格式。
D2：allowedFileRoots 未配置 = 不限。
D3：并发上限信号量实现，默认 10。
D4：用户已授权免确认推进。

# 待解决问题

（无。）

# 验证预期

test-http.js 全绿 + SEA 构建通过 + 1.6 部署验证。
