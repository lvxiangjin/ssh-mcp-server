<div align="center">

<a href="https://linux.do" alt="LINUX DO">
<img src="https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+" />
</a>

# ssh-mcp-server

[简体中文](README.md) | [English](README.en.md)

**给 AI 一把带保险栓的服务器钥匙 🔑**

*让 ZCode / Claude Code / Codex 等任何 MCP 客户端安全地登上你的服务器执行命令、传文件、跑任务——*
*而服务器的 22 端口，从头到尾不需要对 AI（或互联网）开放。*

[![CI](https://github.com/lvxiangjin/ssh-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/lvxiangjin/ssh-mcp-server/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.4.1-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](package.json)
[![protocol](https://img.shields.io/badge/protocol-MCP%20Streamable%20HTTP-orange)](https://modelcontextprotocol.io)
[![deploy](https://img.shields.io/badge/deploy-单文件%20SEA%20·%20零依赖-8A2BE2)](#-部署到服务器http-模式生产推荐)
[![security](https://img.shields.io/badge/security-四层纵深防御-red)](#-安全设计为什么敢让-ai-碰服务器)

</div>

---

```
┌──────────────┐  HTTPS + Bearer Token   ┌──────────────────────┐   SSH(22)          ┌──────────────┐
│   AI 客户端   │ ──────────────────────→ │  Nginx → 本网关（单文件）│ ─────────────────→ │  内网服务器 ×N │
│ ZCode/Claude │     唯一暴露的口子        │   部署在任一台可达机器上  │  22 只对网关放行    │  低权限账号落地 │
└──────────────┘                         └──────────────────────┘                    └──────────────┘
```

**三个一句话卖点：**

- 🚪 **AI 与服务器物理隔离**——AI 只认识网关的 443 端口；目标机 22 端口防火墙只对网关放行，AI 所在的网络被攻破也摸不到服务器
- 🧰 **六个 MCP 工具 + 两个 GB 级流式端点**——执行命令、后台任务、上传下载一个端口全搞定，3GiB 文件恒定内存直达
- 🔐 **为"AI 会犯错"设计的安全模型**——命令黑名单硬拦、高危命令二次确认、敏感路径双拦、防爆破双维计数、全员审计，详见[安全设计](#-安全设计为什么敢让-ai-碰服务器)

## 🆚 它和传统方案的区别

| | 手动 SSH / Xshell | 传统堡垒机<br>(JumpServer / 商用堡垒机) | **ssh-mcp-server** |
|---|---|---|---|
| 为谁设计 | 人类敲键盘 | 人类运维的会话审计 | **AI Agent 自主执行** |
| AI 怎么用 | ❌ 无法接入 | 😩 Web UI/交互式会话，AI 难驱动 | ✅ MCP 原生协议，配置一次，对话即运维 |
| 部署重量 | — | 数据库 + 容器编排 + 多组件 | **一个可执行文件 + 一个 config.json** |
| 服务器暴露面 | 22 对用户网络开放 | 协议网关，较重 | **22 只对网关放行，公网仅 443 一个口** |
| 危险命令拦截 | 无 | 会话录像（事后追责） | **事前拦截**：黑名单 + 高危二次确认 |
| 权限模型 | 账号即权限 | 4A 集中管控 | Token 服务器白名单 × OS 低权限账号，**双层限制** |
| 凭据轮换 | 手动改密码 | 静态或 AD/LDAP | **HMAC 按天自动轮换**，每人独立 secret |
| 文件传输 | scp 手动 | 闪传/网盘中转 | **3GiB 流式直传**，md5 校验，恒定内存 |
| 成本 | — | 企业级授权 / 硬件 | 开源免费 |

> 一句话：堡垒机管的是"人干了什么"，ssh-mcp-server 管的是"**AI 能干什么、不能干什么**"。它不替代堡垒机——很多团队把它部署在堡垒机之后，作为 AI 专属的那一层。

## ✨ 核心能力

**六个 MCP 工具**（一个 443 端口全部搞定）：

| 工具 | 干什么 |
|---|---|
| `list_servers` | 列出该 Token 有权访问的服务器（白名单外的**看不见也不存在**） |
| `run_command` | 执行 shell 命令，返回 stdout/stderr/退出码；支持 `cwd`、`background` 后台执行、`confirm` 高危复核 |
| `check_job` | 查询后台任务状态/退出码/输出尾部（状态落目标机，网关重启不丢，7 天自动清理） |
| `kill_job` | 终止后台任务（防 PID 复用误杀） |
| `upload_file` | SFTP 上传（≤5MB，自动建父目录、原子覆盖、返回 md5） |
| `download_file` | SFTP 下载（自动识别文本/二进制，附 md5 校验） |

**两个流式端点**（不走 MCP、不经 base64 膨胀）：

- `POST /upload`：GB 级文件流式上传，默认上限 3GiB 可调更大，恒定内存，返回远端 md5
- `GET /download`：不限大小流式下载，响应头 `X-Md5` / `X-File-Size` 先行供校验

其他内建能力：执行超时、输出截断（保头 60% + 尾 40%，防撑爆 AI 上下文）、SSH 并发上限、连接失败自动重试。

## 🤖 结合 AI 工具，能玩出什么

任何支持 MCP 的客户端都能接：**ZCode、Claude Code、Codex、Cursor、Cline……** 配置一次，之后所有运维都是"说人话"。

**场景 1 · 运维副驾驶**——对话即操作：

> 「看下 web1、web2 的磁盘占用，超 80% 的把 /var/log 下 7 天前的日志清了」

AI 自己调 `list_servers` → 逐台 `run_command` → 汇总结果给结论。你不用登任何一台机器。

**场景 2 · 代码改完直接上天**——开发到部署零切换：

> 「这个 bug 修好了，发到测试机验证一下」

AI 在本地改代码 → 构建 → `POST /upload` 流式传包 → `run_command` 重启服务 → `check_job`/`curl` 验证 → 报告结果。全程没有人工 ssh，每一步都过安全防线、留审计。

**场景 3 · 无人值守值班**——把巡检交给定时任务：

用 ZCode 的定时任务（或系统 cron 拉起 AI 客户端）每天凌晨自动巡检：磁盘/内存/证书到期/服务存活，异常时才把报告推给你。低权限 Token 限定了它即使"抽风"也只能在白名单机器上做白名单外的事——做不了。

**场景 4 · 团队分级授权**——每个人、每个 AI 客户端一张专属门禁卡：

给每个同事发独立的 `hmacUsers` Token（**每天自动换**、各自 secret、各自服务器白名单），命令在各自低权限 OS 账号上落地。实习生和运维总监看到的服务器列表都不一样；谁的车钥匙丢了，吊销一张卡即可，不影响别人。

**接入配置**：

ZCode（`~/.zcode/cli/config.json` 用户级，或项目级 `.zcode/config.json`，改完重启生效）：

```jsonc
{
  "mcp": {
    "servers": {
      "ssh-gateway": {
        // 方式一：网关在本机（stdio）
        "command": "node",
        "args": ["/opt/ssh-mcp-server/server.js"]
        // 方式二：网关在远程（HTTP，推荐生产）
        // "type": "streamableHttp",
        // "url": "https://mcp.example.com/mcp",
        // "headers": { "Authorization": "Bearer <你的token>" }
      }
    }
  }
}
```

Claude Code：

```bash
claude mcp add --transport http ssh-gateway "https://mcp.example.com/mcp" \
  --header "Authorization: Bearer <你的token>"
```

其他 MCP 客户端（Cursor / Cline / Codex 等）按各自的 MCP 配置格式填**同一个 URL + 同一个 Authorization Header** 即可。

## 🔒 安全设计：为什么敢让 AI 碰服务器

核心思路：**不信任 AI 的任何一次输出**。AI 生成的每一条命令都当作不可信输入，过完层层防线才落地，且落地账号本身就没有破坏力。

```
 互联网请求
    │
    ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ ① 传输层   Nginx 443 唯一入口（或内置 TLS）+ 可选 IP 白名单      │
 ├─────────────────────────────────────────────────────────────┤
 │ ② 身份层   Bearer Token：多静态 / HMAC 按天轮换 / 每人独立      │
 │            失败统一 401，不泄露任何凭据状态                      │
 ├─────────────────────────────────────────────────────────────┤
 │ ③ 防爆破层  双维计数(IP×凭据) → 封 IP/封组合 → 429+Retry-After │
 │            trustedProxies 防伪造头绕过 / banAllowlist 管理网段 │
 ├─────────────────────────────────────────────────────────────┤
 │ ④ 授权层   Token 级服务器白名单：越权目标"看不见"，拒绝不泄露    │
 ├─────────────────────────────────────────────────────────────┤
 │ ⑤ 命令防线  黑名单硬拦（引号/包裹变体防绕过，内置兜底+自定义合并）│
 │            高危命令二次确认：命中默认拒绝，confirm 复核才放行    │
 ├─────────────────────────────────────────────────────────────┤
 │ ⑥ 文件防线  路径规范化/符号链接真实路径解析/敏感文件读写双拦     │
 │            allowedFileRoots 目录白名单 / 原子覆盖 / 大小上限    │
 ├─────────────────────────────────────────────────────────────┤
 │ ⑦ 执行层   专用低权限 OS 账号 + sudo 白名单落地（损害兜底）      │
 │            超时 / 输出截断 / SSH 并发上限 / 主机指纹防中间人     │
 ├─────────────────────────────────────────────────────────────┤
 │ ⑧ 审计层   JSONL 按天：谁、从哪个 IP、对哪台、执行了什么、        │
 │            返回了什么（结果摘要）——事后可完整追责               │
 └─────────────────────────────────────────────────────────────┘
```

### 每一层的关键细节

**② 身份层——凭据不落配置、按天自换、可单独吊销**

- 三类凭据来源并存：多静态 Token（按 id 区分身份，支持 `expiresAt` 过期、`disabled` 禁用、新旧并存轮换）、HMAC 派生 Token（两端只存 master secret，Token 每天自动变，无需改配置重启）、`hmacUsers` 每人独立 secret（泄露一人只影响其自身白名单范围）
- `SSH_MCP_TOKEN_FILE` 从 0600 权限文件读 Token，group/other 可写直接**拒绝启动**
- 设计哲学 **fail-closed**：`expiresAt` 解析失败按已过期处理、三类凭据全缺拒绝启动、非法/冲突配置拒绝启动——宁可起不来，绝不带病运行

**③ 防爆破层——在线暴露也不怕撞库**

- 失败计数按「**来源 IP × 提交凭据指纹**」二元组：只换 IP 或只换 Token 都绕不过；同 IP 跨凭据累计失败达阈值升级封禁整个 IP
- `trustedProxies`（IP/CIDR）：只有 TCP 对端命中白名单才采信 `X-Real-IP`/`X-Forwarded-For`（取最右项）——**伪造代理头无法再洗白限速计数**
- `banAllowlist` 管理网段永不计数，防攻击者故意触发封禁把管理员锁在门外

**⑤ 命令防线——假设 AI 总有一天会写出 `rm -rf /`**

- 危险命令黑名单：`rm -rf /` 及其变体、`mkfs`、`dd` 写盘、fork 炸弹、`shutdown`、`chmod -R 777 /`、`kill -9 -1`、清空磁盘设备……命中**硬拒**，`confirm: true` 也救不回
- 内置最低兜底黑名单与自定义 config **合并生效**（v0.4 修复了 `bash -c "rm -rf /"` 类引号包裹绕过），不依赖部署方更新配置
- 高危命令二次确认：`rm -rf` 变体、`shred`、`find / -delete`、系统关键文件重定向等命中默认拒绝并返回命中说明，AI 复核确认（`confirm: true`）后才执行——**误操作有人工节拍，破坏操作无豁免**

**⑥⑦ 文件与执行——就算防线全过，落地账号也掀不起浪**

- 敏感路径黑名单读写双拦：`/etc/shadow`、`authorized_keys`、`sshd_config`、`/boot` 等
- 文件工具仅接受绝对路径，处理 `..`/重复斜杠，在目标机**解析符号链接真实路径**后再校验 `allowedFileRoots`
- 上传先写临时文件再原子 rename，中断不毁原文件
- 配套 `scripts/setup-limited-user.sh` 一键创建 AI 专用低权限账号（sudoers 强制 `--no-pager`，防分页器逃逸提权）
- SSH 主机指纹校验（SHA-256），防中间人替换目标机
- 命令超时 + 输出截断，防 `tail -f` 拖死网关、防超大输出撑爆 AI 上下文

**⑧ 审计层——每一笔都有账**

`audit.enabled` 开启后 JSONL 按天落盘：调用者身份、来源 IP、目标服务器、命令全文、返回结果摘要（头 1024 + 尾 256 字符，可调/可关）。不记文件内容与 Token 原值，审计日志本身不成为新的泄密点。

### 上线前安全清单

- [x] HTTP 模式强制 Bearer 鉴权，鉴权失败统一 401 不泄露状态
- [x] 防爆破双维限速封禁（429 + Retry-After），代理头伪造不可绕过
- [x] 危险命令黑名单 + 高危命令二次确认（网关侧拦截；权限隔离仍靠低权限账号兜底）
- [x] 命令超时 / 输出截断 / 上下行大小上限 / SSH 并发上限
- [x] 敏感路径读写双拦 + 符号链接真实路径解析 + 目录白名单
- [x] 审计日志（可选开启，JSONL 按天，含命令全文与结果摘要）
- [x] 移除 `X-Powered-By` 框架指纹头，不向探测方暴露技术栈
- [ ] 给 AI 配**专用低权限 SSH 账号**，提权走 sudo 白名单（目标机上配，`scripts/setup-limited-user.sh` 一键搞定）
- [ ] 目标机 22 端口防火墙**只对网关机器放行**
- [ ] 公网暴露务必 Nginx + HTTPS（可选再加 IP 白名单，反代开启 `SSH_MCP_TRUST_PROXY=1`）
- [ ] 多客户端分身份发 Token（泄露即禁用单个 id），生产建议 `hmacUsers` 每人独立 secret

## 🚀 快速开始（本机 stdio 模式）

```bash
npm install
cp config.example.json config.json
# 编辑 config.json：把 servers[0] 换成你的服务器（host/username/privateKeyPath，
# config.json 已 gitignore，不会误提交真实环境信息）
node test-direct.js     # 直连测试（不走 MCP）
node test-mcp.js        # stdio MCP 协议测试
node test-http.js       # HTTP 网关模式测试（含 401 鉴权验证）
```

> 环境要求：Node.js >= 20（实测 node 18 下 MCP SDK 1.30 的 HTTP 模式会报
> `crypto is not defined`，Ubuntu apt 版 node 尤其注意；SEA 产物自带运行时无此问题）。

## 📦 部署到服务器（HTTP 模式，生产推荐）

### 方式 A：单文件部署（推荐，服务器零安装）

打包成**一个自带 Node 运行时的可执行文件**（约 120MB），服务器上不需要安装
Node/npm/任何依赖。在任意 Linux 机器（或 WSL，需 Node >= 20）上执行：

```bash
bash scripts/build-linux.sh
# 产物：dist/ssh-mcp-server-linux
```

部署只需两个文件：

```bash
scp dist/ssh-mcp-server-linux config.json user@your-server:/opt/ssh-mcp/
# 服务器上：
cd /opt/ssh-mcp && chmod +x ssh-mcp-server-linux
SSH_MCP_TRANSPORT=http SSH_MCP_TOKEN=<你的强随机token> ./ssh-mcp-server-linux
```

配置文件查找顺序：`SSH_MCP_CONFIG` 环境变量 → **可执行文件同目录** → 当前目录。
systemd 里把 `ExecStart` 指向该二进制即可（其余环境变量同下表）。

> 打包机需要网络（npm 拉取 esbuild/postject），产物服务器完全离线可用。
> Windows 版可参照脚本在 Windows 上用相同流程（postject 支持 PE 注入）。

### 方式 B：源码部署

```bash
# 1. 拷贝整个目录到服务器（Node.js >= 20）
npm install --omit=dev

# 2. 生成一个强随机 Token（或 node scripts/gen-token.js）
openssl rand -hex 32

# 3. 启动
SSH_MCP_TRANSPORT=http \
SSH_MCP_HOST=127.0.0.1 \
SSH_MCP_PORT=8080 \
SSH_MCP_TOKEN=<你的token> \
node server.js
```

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `SSH_MCP_TRANSPORT` | `stdio` 或 `http` | `stdio` |
| `SSH_MCP_HOST` | HTTP 监听地址 | `127.0.0.1`（配合 Nginx） |
| `SSH_MCP_PORT` | HTTP 监听端口 | `8080` |
| `SSH_MCP_TOKEN` | Bearer Token（静态凭据来源之一；多 Token/自动轮换见 config.json 的 `auth` 段，三类来源全缺时拒绝启动） | — |
| `SSH_MCP_TOKEN_FILE` | 从私有权限文件读取 Token（首行，与 `SSH_MCP_TOKEN` 互斥，权限过宽拒绝启动） | — |
| `SSH_MCP_TLS_CERT` / `SSH_MCP_TLS_KEY` | 内置 HTTPS：配置后全端点 TLS 加密（证书可用 `scripts/gen-cert.sh` 生成） | 关闭 |
| `SSH_MCP_TRUST_PROXY` | 置 `1` 信任 `X-Real-IP`/`X-Forwarded-For`（兼容旧配置；生产建议改用 config 的 `auth.trustedProxies` 精确白名单） | 关闭 |
| `SSH_MCP_CONFIG` | 配置文件路径 | 同目录 `config.json` |

### systemd 常驻

```ini
# /etc/systemd/system/ssh-mcp.service
[Unit]
Description=SSH MCP Gateway
After=network.target

[Service]
WorkingDirectory=/opt/ssh-mcp-server
ExecStart=/usr/bin/node server.js
Environment=SSH_MCP_TRANSPORT=http
Environment=SSH_MCP_HOST=127.0.0.1
Environment=SSH_MCP_PORT=8080
Environment=SSH_MCP_TOKEN=换成你的强随机token
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now ssh-mcp
```

### Nginx 反向代理 + HTTPS

```nginx
# /etc/nginx/conf.d/ssh-mcp.conf
server {
    listen 443 ssl;
    server_name mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    # 可选：再加一层 IP 白名单
    # allow 你的出口IP;
    # deny all;

    location /mcp {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # MCP 可能为长连接响应，关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 660s;
        # 重要：upload_file 的内容走 base64（体积膨胀约 1/3），
        # 默认上限 5MB 文件需要 ~10m 的 body 限制
        client_max_body_size 10m;
    }

    # 大文件流式上传（可选启用）：按 maxStreamUploadBytes 放开 body 限制
    location /upload {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_request_buffering off;      # 流式透传，不在 Nginx 落盘
        client_max_body_size 0;           # 0 = 不限；或按 maxStreamUploadBytes 设置
        proxy_read_timeout 3600s;
    }
}
```

AI 客户端最终访问：`https://mcp.example.com/mcp`

### 大文件上传 / 下载（流式端点）

MCP 的 `upload_file`/`download_file` 走 base64/JSON，只适合中小文件。GB 级文件用网关流式端点，
请求/响应体直接在网关与目标机 SFTP 之间搬运（恒定内存、不经 MCP、返回远端 md5）：

```bash
TOKEN=<你的token>
# POST（curl 会流式读文件，不占内存）
curl -X POST -H "Authorization: Bearer $TOKEN" \
     --data-binary @bigfile.iso \
     "http://127.0.0.1:18080/upload?path=/opt/bigfile.iso"
# PUT 语义等价：curl -T bigfile.iso -H "..." "http://.../upload?path=/opt/bigfile.iso"
# 可选参数：&server=<服务器id>&mode=0600
```

**下载**同样流式（SFTP 读流直透响应，不限大小，响应头 `X-Md5`/`X-File-Size` 先行供校验）：

```bash
curl -H "Authorization: Bearer $TOKEN" -o bigfile.iso \
     "http://127.0.0.1:18080/download?path=/opt/bigfile.iso"
```

上限由 config.json 的 `defaults.maxStreamUploadBytes` 控制（默认 3GiB=3221225472，可调更大）。

**云服务器安全组只需放行 443（或 80）一个端口**——六个 MCP 工具
（run_command / check_job / kill_job / upload_file / download_file / list_servers）
与两个流式端点（/upload、/download）都经由这同一个端口完成，经 Nginx 反代即可使用。

## ⚙️ config.json 说明

```jsonc
{
  "servers": [                        // 多台服务器随便加
    {
      "id": "web1",                   // AI 调用时引用的 ID
      "name": "官网生产机",             // 备注名
      "host": "10.0.0.11",            // 内网地址（只要网关机器能连到）
      "port": 22,
      "username": "deploy",           // 建议专用低权限账号
      "privateKeyPath": "~/.ssh/id_ed25519",
      "hostFingerprint": "SHA256:xxxx",  // 可选：SSH 主机指纹校验
      "allowedFileRoots": ["/opt/apps", "/tmp"]  // 可选：限制文件操作目录（含符号链接真实路径）
    }
  ],
  "defaults": {
    "serverId": "web1",               // run_command 不传 server 时的默认目标
    "timeoutMs": 30000,               // 命令超时
    "maxOutputBytes": 65536,          // 输出截断上限（防撑爆 AI 上下文）
    "maxUploadBytes": 5242880,        // 单文件上传上限（5MB）
    "maxDownloadBytes": 524288,       // 单文件下载上限（512KB）
    "maxStreamUploadBytes": 3221225472, // /upload 流式上传上限（3GiB，可调更大）
    "maxConcurrentSsh": 10            // 全局 SSH 连接并发上限
  },
  "blockedPathPatterns": [            // 敏感路径黑名单（读写均拦截）
    "^/etc/(passwd|shadow|gshadow|sudoers)",
    "^/etc/ssh/sshd_config",
    "authorized_keys$",
    "known_hosts$",
    "^/boot/"
  ],
  "blockedCommandPatterns": [         // 危险命令黑名单（正则，忽略大小写；与内置兜底合并生效）
    "rm\\s+-[a-zA-Z]*[rf][a-zA-Z]*\\s+/(\\s|$|\\*)",
    "\\bmkfs(\\.\\w+)?\\b",
    "\\bdd\\b[^|]*if=/dev/(zero|random)",
    "\\bdd\\b[^|]*of=/dev/(sd|hd|nvme|vd)",
    ":\\(\\)\\s*\\{.*\\};\\s*:",
    "\\b(shutdown|reboot|halt|poweroff)\\b",
    "\\binit\\s+[06]\\b",
    ">\\s*/dev/sd[a-z]",
    "chmod\\s+(-[a-zA-Z]+\\s+)*777\\s+/(\\s|$)",
    "pkill\\s+(-[a-zA-Z0-9]+\\s+)*-f\\s+(['\"]{0,2})\\s*$",
    "\\bkill\\s+(-9\\s+)?-1\\b",
    "\\bkill\\s+--\\s+-1\\b"
  ],
  "auth": {                           // HTTP 鉴权（可选；与 SSH_MCP_TOKEN 并存，全缺时拒绝启动）
    "trustedProxies": ["127.0.0.1"],  // 采信 X-Real-IP/XFF 的反代网段（IP/CIDR）
    "banAllowlist": ["10.0.0.0/24"],  // 封禁豁免网段：永不计数、永不 429
    "confirmPatterns": [              // 可选：高危命令二次确认清单（显式配置即完全覆盖默认清单）
      "rm\\s+-[a-zA-Z]*[rf]",
      "shred\\s",
      "find\\s+/.*-delete"
    ],
    "tokens": [                       // 多静态 Token：按 id 区分调用方，支持过期/禁用/服务器白名单
      { "id": "alice", "token": "<64位hex>", "note": "主力客户端" },
      { "id": "old", "token": "<64位hex>", "expiresAt": "2026-10-01T00:00:00Z" },
      { "id": "emp", "token": "<64位hex>", "servers": ["self-limited"] }  // 该 Token 只能访问指定服务器
    ],
    "hmac": {                         // HMAC 派生 Token 自动轮换（scripts/derive-token.js 推导）
      "secret": "<master-secret>",    // 注意：全局派生 Token 不受 servers 白名单限制，仅发可信调用方
      "periodHours": 24,              // 时间桶周期，默认 24h
      "graceBuckets": 1               // 接受当前桶 ±N，默认 1
    },
    "hmacUsers": [                    // 每人独立 HMAC secret：自动轮换 + 各自服务器白名单（两全）
      { "id": "emp-alice", "secret": "<每人独立随机串>", "servers": ["self-limited"] }
    ],
    "rateLimit": { "windowMs": 60000, "maxFails": 10, "banMs": 600000 }  // 防爆破
  },
  "audit": { "enabled": true, "dir": "/var/log/ssh-mcp" }  // 审计日志（默认关闭；JSONL 按天）
}
```

获取目标机 SSH 指纹（建议从可信网络或服务器控制台核对）：

```bash
ssh-keyscan -t ed25519 10.0.0.11 2>/dev/null | ssh-keygen -lf - -E sha256
```

## 🧪 测试环境说明（Windows + WSL2）

<details>
<summary>本项目在 Windows 11 + WSL2(Ubuntu-24.04) 上完成验证，该环境有两个已知坑（点开）</summary>

1. **Hyper-V 防火墙默认拦截 Windows→WSL 的直连**。已用管理员 PowerShell 放行：
   ```powershell
   Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
   ```
   （改回 `Block` 即可还原）
2. **WSL 空闲一段时间后网络会"漂移"（连接超时）**，且重启后 IP 可能变化。
   重新测试时运行 `bash scripts/start-wsl-test.sh`，它会重启 WSL、更新 config.json 里的 IP
   并连跑三个测试。生产部署在真实 Linux 服务器上不存在这些问题。

</details>

## 📜 更新日志

见 [CHANGELOG.md](CHANGELOG.md)（当前 0.4.1）。
