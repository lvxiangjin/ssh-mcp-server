# 完整目标规格：项目文档（project-docs）

本规格描述 change 完成后，ssh-mcp-server 仓库中项目文档能力的完整行为。

## 1. 文档集合

仓库 `docs/` 目录下新增两份独立 Markdown 文档，与既有 `README.md` 互补：

| 文件 | 受众 | 定位 |
|---|---|---|
| `docs/使用说明.md` | 部署者、AI 客户端使用者 | 操作手册：装、配、接、用、排障 |
| `docs/开发需求文档.md` | 开发者、维护者 | 需求规格：为什么做、做了什么、怎么算做完 |

两份文档均为中文；不修改 `README.md` 与任何源码。

## 2. 使用说明文档的完整内容要求

`docs/使用说明.md` 必须按以下结构组织（章节名为验收比对基准）：

- **项目简介**：一句话定位（AI 通过 MCP 协议在指定服务器执行 SSH 命令与文件传输的网关），说明 AI 不直连 22 端口、网关统一出口的核心价值。
- **整体架构**：文字或 ASCII 架构图，覆盖 AI 客户端 →（HTTP/stdio + Bearer Token）→ 网关 →（内网 SSH）→ 目标服务器三条链路。
- **快速开始（stdio 模式）**：`npm install` → 编辑 `config.json`（servers 数组各字段含义）→ 在 AI 客户端配置 stdio MCP server → 验证（`node test-direct.js`、`node test-mcp.js`）。
- **服务器部署**：三种形态——
  - 单文件部署：`bash scripts/build-linux.sh` 打包 SEA 单文件，`scp` 二进制 + `config.json` 两个文件上服务器即可运行，服务器零安装；
  - systemd 常驻：service 文件示例（含 `SSH_MCP_TRANSPORT=http`、`SSH_MCP_TOKEN` 等环境变量）；
  - Nginx 反代：HTTPS 反代 `/mcp` 的 location 配置要点（proxy_buffering off、client_max_body_size 10m、read_timeout）。
- **AI 客户端接入**：ZCode / Claude 等 MCP 客户端的 JSON 配置示例，stdio 与 streamableHttp 两种形态，HTTP 形态必须带 `Authorization: Bearer <token>` 请求头。
- **工具参考**：四个工具逐一说明用途、输入参数（类型、必填性、默认值）、返回内容、错误行为：
  - `list_servers`：列出 config.json 中配置的服务器，标注默认服务器；
  - `run_command`：参数 command（必填）、server（可选，缺省用 defaults.serverId）、timeout_ms（可选，默认 30000、上限 600000）；返回 server/exit_code/stdout/stderr，超时与截断的标注方式；
  - `upload_file`：参数 remote_path（必填）、content_base64（必填）、mode（可选八进制权限）、server（可选）；自动创建父目录；返回服务端 md5；上限 5MB（defaults.maxUploadBytes 可调）；
  - `download_file`：参数 remote_path（必填）、max_bytes（可选，默认 512KB）、server（可选）；文本以 utf8 返回、二进制以 base64 返回；返回 size/encoding/md5。
- **安全配置**：HTTP 模式强制 Bearer Token（缺失拒绝启动）；`blockedCommandPatterns` 危险命令黑名单（正则、忽略大小写、命中即拒）；`blockedPathPatterns` 敏感路径黑名单（读写双向拦截）；`maxUploadBytes`/`maxDownloadBytes`/`maxOutputBytes` 大小上限；连接失败自动重试一次；部署安全清单（专用低权限账号、22 端口仅对网关放行、Token 保管与轮换）。
- **常见问题**：WSL 环境注意事项（Hyper-V 防火墙放行命令、空闲断连、IP 漂移与 `scripts/start-wsl-test.sh`）；Node 版本要求（≥20，node18 下 SDK HTTP 模式报 crypto is not defined）；交互式命令不支持及替代写法；`EADDRINUSE` 端口占用处理。

## 3. 开发需求文档的完整内容要求

`docs/开发需求文档.md` 必须按以下结构组织：

- **背景与目标**：AI 运维场景痛点（AI 无法安全直连 SSH、云服务器端口收敛、审计与管控需求），本网关的目标定位。
- **用户故事**：至少覆盖——运维人员部署网关统一管控服务器；AI 使用者让 AI 执行命令/传文件；安全管理员配置黑名单与 Token。
- **功能需求**：使用 FR 编号，每条含描述与可检验验收标准，至少覆盖：
  - FR1 远程命令执行（同步返回 stdout/stderr/退出码；超时保护；输出截断；失败自动重试一次）；
  - FR2 文件上传（SFTP、base64、自动建父目录、可选权限、返回服务端 md5、大小上限）；
  - FR3 文件下载（文本/二进制自适应编码、md5/size/encoding 元信息、大小上限与超限明确报错）；
  - FR4 多服务器管理（config.json 声明式配置、server 参数选择、默认服务器）；
  - FR5 安全拦截（危险命令黑名单、敏感路径读写双向拦截、HTTP 强制 Bearer Token、错误 Token 401）；
  - FR6 双传输模式（stdio 本机模式 / HTTP 可反代模式；无状态 HTTP 设计不依赖会话粘性）；
  - FR7 单文件打包部署（SEA 打包自带运行时、目标机零安装、配置文件查找顺序：环境变量→可执行文件同目录→当前目录）。
- **非功能需求**：性能（命令超时默认 30s 可配、连接建立预留 15s）、安全（见 FR5 + Token 强度与保管建议）、可维护性（配置驱动、与 MCP 协议解耦的 lib.js 分层、可重复执行的测试脚本）。
- **约束与技术选型**：Node.js ≥ 20；MCP 官方 SDK；ssh2（SSH/SFTP）；express（HTTP 传输）；SEA + esbuild + postject 打包；密钥认证优先。
- **非目标**：不提供交互式终端；不做 Web 界面；不内置审计日志存储；不做多租户/多用户权限体系。
- **后续规划（非本期）**：明确标注"以下为非本期范围的路线图"——审计日志落库、多用户与审批流、交互式命令会话、文件增量同步、Web 管理面板。

## 4. 一致性不变量

- 工具名、参数名、环境变量名、config.json 字段名必须与仓库 `server.js`、`lib.js`、`config.json` 逐一对应，不得虚构。
- 操作命令必须与 `scripts/`（build-linux.sh、start-wsl-test.sh）、`README.md`、`package.json` scripts 中的既有用法一致。
- 数值基线：默认超时 30000ms、超时上限 600000ms、上传上限 5242880 字节、下载默认上限 524288 字节、输出截断默认 65536 字节、连接建立预留 15 秒、重试间隔 1.2 秒。

## 5. 交付与入库

- 两份文档随 change 一起 git 提交，推送至 `https://github.com/lvxiangjin/ssh-mcp-server.git` main 分支。
- 不修改源码与既有部署物；`10.0.0.11` 上的网关与 systemd 服务保持现状。

## 验收场景

Scenario: 使用说明覆盖部署与接入全流程
  当读者打开 `docs/使用说明.md`，则文档为中文且依次包含：项目简介、整体架构、快速开始（stdio 模式）、服务器部署（单文件打包/systemd/Nginx 反代）、AI 客户端接入、工具参考（四个工具各自的用途、参数表、返回说明）、安全配置（Token/双黑名单/大小上限）、常见问题（含 WSL 注意事项与 Node 版本要求）全部章节。

Scenario: 开发需求文档正式化需求与验收
  当读者打开 `docs/开发需求文档.md`，则文档为中文且依次包含：背景与目标、用户故事、功能需求（FR1~FR7 编号且每条带验收标准）、非功能需求、约束与技术选型、非目标、后续规划（标注非本期）全部章节。

Scenario: 文档与实现一致
  当对照仓库内 `server.js`、`lib.js`、`config.json` 检查两份文档，则文档中的工具名（list_servers/run_command/upload_file/download_file）、环境变量名（SSH_MCP_TRANSPORT/SSH_MCP_HOST/SSH_MCP_PORT/SSH_MCP_TOKEN/SSH_MCP_CONFIG）、配置字段名与数值基线（超时 30000ms、上传 5MB、下载 512KB）与实现完全一致，无虚构参数。

Scenario: 操作示例可直接照做
  当对照 `scripts/`、`README.md`、`package.json` 检查文档中的示例命令，则 npm install、打包脚本、systemd 单元、Nginx 配置、ssh 隧道、MCP 客户端 JSON 配置等示例与仓库既有用法一致且路径、脚本名真实存在。

Scenario: 文档入库推送
  当两份文档完成编写后，则它们已 git 提交并推送到 Gitea main 分支，`git ls-remote origin` 的 main 指向包含这两份文件的提交，且工作区干净。
