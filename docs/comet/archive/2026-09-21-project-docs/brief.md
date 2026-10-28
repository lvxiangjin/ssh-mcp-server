# 目标

为 ssh-mcp-server 项目（AI 的 SSH 网关，MCP Server）产出两份正式中文文档，并提交推送到项目 Gitea 仓库：

1. `docs/使用说明.md` —— 面向部署者与 AI 客户端使用者的操作手册；
2. `docs/开发需求文档.md` —— 面向开发/维护者的需求规格说明书（将当前已实现能力正式化为需求与验收标准）。

# 范围

- 新增 `docs/使用说明.md`：项目简介、整体架构、快速开始（stdio 模式）、服务器部署（单文件 SEA 包 / systemd / Nginx 反代）、AI 客户端接入（ZCode / Claude 等 MCP 配置）、工具参考（list_servers / run_command / upload_file / download_file 的参数与返回说明）、安全配置（Token 鉴权、危险命令黑名单、敏感路径黑名单、超时与大小限制）、常见问题（含 WSL 环境注意事项）。
- 新增 `docs/开发需求文档.md`：背景与目标、用户故事、功能需求（FR 编号、每条带验收标准，覆盖命令执行 / 文件上传 / 文件下载 / 多服务器管理 / 安全拦截 / stdio+HTTP 双传输模式 / 单文件打包零依赖部署）、非功能需求（性能、安全、可维护性）、约束与技术选型、非目标、后续规划（明确标注为非本期范围）。
- 两份文档 git 提交并推送到 `https://github.com/lvxiangjin/ssh-mcp-server.git` 的 main 分支。

# 非目标

- 不修改任何源码、配置文件与既有部署物（10.0.0.11 上的网关与 systemd 服务保持现状）。
- 不重写现有 `README.md`（两份新文档与其互补）。
- 不产出英文版本。
- 不实现"后续规划"中的任何条目（审计日志、多用户、审批流等仅作为路线图标注为非本期）。

# 验收示例

- A1: `docs/使用说明.md` 存在且为中文，包含以下全部章节：项目简介、整体架构、快速开始（stdio 模式）、服务器部署（含单文件打包、systemd、Nginx 反代）、AI 客户端接入（MCP 配置示例）、工具参考（list_servers / run_command / upload_file / download_file 四个工具各自的用途、参数表与返回说明）、安全配置（Token 鉴权、危险命令黑名单、敏感路径黑名单、超时与大小限制）、常见问题。
- A2: `docs/开发需求文档.md` 存在且为中文，包含以下全部章节：背景与目标、用户故事、功能需求（使用 FR 编号，每条带可检验的验收标准，且覆盖：远程命令执行、文件上传、文件下载、多服务器管理、危险命令与敏感路径拦截、stdio/HTTP 双传输模式、单文件打包零依赖部署）、非功能需求（性能、安全、可维护性）、约束与技术选型、非目标、后续规划（明确标注为非本期范围）。
- A3: 两份文档中出现的工具名、环境变量名（SSH_MCP_TRANSPORT / SSH_MCP_HOST / SSH_MCP_PORT / SSH_MCP_TOKEN / SSH_MCP_CONFIG）、config.json 字段名与 `server.js` / `lib.js` / `config.json` 的实际实现完全一致，无虚构的参数或字段。
- A4: 文档中的操作示例命令（npm install、node server.js、打包脚本、systemctl、ssh 隧道、MCP 客户端 JSON 配置）与仓库内 `scripts/`、`README.md` 的既有用法一致，可直接照做。
- A5: 两份文档已 git 提交并成功推送到 Gitea main 分支（`git ls-remote` 可见包含这两份文件的最新提交）。

# 约束与不变量

- 文档语言：中文（与用户语言及既有 README 一致）。
- 格式：Markdown，入库随 Git 同步。
- 事实一致性：所有技术细节必须来自当前仓库的真实实现，不得虚构功能、参数或行为。
- 文档事实基线：Node.js ≥ 20；四个 MCP 工具；stdio/HTTP 双模式；SEA 单文件打包；危险命令黑名单与敏感路径黑名单双向拦截；上传上限 5MB、下载默认上限 512KB；HTTP 模式强制 Bearer Token。

# 决策

- 文档放在仓库 `docs/` 目录（与 Native 产物根一致，用户可见路径清晰）。
- 文件名使用中文名 `使用说明.md` 与 `开发需求文档.md`（与用户请求的叫法直接对应）。
- "开发需求文档"定位为：把当前已实现能力正式化为需求规格（每条带验收标准），并附"后续规划"章节、明确标注为非本期，而非凭空虚构未来需求。
- 交付即入库推送（沿用本项目既有的 git 工作流，推送目标是用户指定的 Gitea 地址）。

# 待解决问题

（无 —— 无阻塞问题）

# 验证预期

- Verifier 以只读方式核对：A1/A2 的章节存在性（逐章节比对标题）、A3/A4 的一致性（对照仓库内 server.js / lib.js / config.json / scripts / README）、A5 的推送状态（git ls-remote 与本地 HEAD 比对）。
- 无需运行网关服务即可完成验证（纯文档验收 + git 状态检查）。
