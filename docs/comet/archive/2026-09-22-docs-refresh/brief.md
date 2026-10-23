# 目标

巡检并更新仓库全部 markdown 文档，使其与 gateway-usability 之后的软件现状一致（六个 MCP 工具、/upload + /download 两个流式端点、后台任务能力、CHANGELOG 未发布段）。

# 范围

- README.md:178 "全部工具（4 个列表）"陈旧引用 → 六工具 + 两流式端点现状；大文件章节补 GET /download 示例；
- docs/使用说明.md:168 "四个工具" → 六个工具；
- docs/开发需求文档.md:107 "四个工具" → 六个工具；
- CHANGELOG.md 新增 `[未发布]` 小节，完整记录 gateway-usability 变更（后台任务/check_job/kill_job、GET /download、cwd、审计 result、智能截断、setup-limited-user.sh、黑名单加固）。

# 非目标

- 不改任何功能代码与配置；不做版本号变更（未发布内容待下次发版归档）。

# 验收示例

- A1：上述 4 处过期引用全部更新，grep 全仓不再有"四个工具/（run_command / upload_file / download_file / list_servers）"式的旧工具清单残留；
- A2：README 大文件章节含 GET /download 用法；
- A3：CHANGELOG [未发布] 小节完整覆盖 gateway-usability 变更点。

# 决策

- D1（用户 2026-09-22 指示巡检更新并提交）：纯文档变更，依据既有授权免确认推进。
- D2：本轮变更计入 CHANGELOG `[未发布]` 小节——v0.3.0 tag 已冻结，下次发版时归档。

# 待解决问题

（无。）

# 验证预期

- grep 断言：旧清单引用 0 处残留；[未发布] 小节存在且含关键词（check_job、/download、cwd、审计）。
