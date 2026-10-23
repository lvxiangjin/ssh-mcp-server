# Capability: tls-http —— HTTP(S) 可选传输加密

本规格描述归档后 ssh-mcp-server HTTP 传输模式的 TLS 加密行为。TLS 为可选能力：配置证书后网关以 HTTPS 监听并全端点加密；不配置时保持既有纯 HTTP 行为，完全向后兼容。stdio 模式不在本 capability 范围内。

## 1. 配置来源

证书与私钥按以下优先级取一处（不允许混用两个来源）：

1. 环境变量：`SSH_MCP_TLS_CERT`、`SSH_MCP_TLS_KEY`（PEM 文件路径）；
2. `config.json` 的 `tls: { "cert": "<路径>", "key": "<路径>" }`。

判定规则：

- 两者都未配置（或均为空）→ 纯 HTTP 监听，行为与 0.3.x 完全一致；
- 只配置 cert 未配置 key（或反之），无论来自哪个来源 → 拒绝启动，错误信息指明缺失项；
- 配置的文件不存在、不可读、或不是可解析的 PEM → 拒绝启动（配置错误早暴露，运行期不做降级）。

## 2. 监听行为

- TLS 配置齐备时：以 `node:https` 创建服务（零新增第三方依赖），监听 `SSH_MCP_HOST:SSH_MCP_PORT`（默认 127.0.0.1:8080；1.6 部署为 0.0.0.0:18080）；TLS 1.2 及以上握手成功。
- 启动日志明确打印监听协议（`http` 或 `https`）、地址与端口。
- 未配置证书时的启动日志与行为与现状一致。

## 3. 端点一致性

`/healthz`、`/mcp`、`/upload`、`/download` 在 HTTPS 下与 HTTP 下行为完全一致：Bearer 鉴权、防爆破（429/Retry-After）、审计、流式上传下载、`X-Md5`/`X-File-Size` 响应头均不变。明文 HTTP 请求打到 HTTPS 端口时连接被 TLS 层拒绝（无明文响应），即不存在"加密端口上的明文通道"。

## 4. 自签证书辅助

新增 `scripts/gen-cert.sh`：一键生成自签证书对（EC P-256），支持 `-o <输出目录>`、`-n <CN>`、`-a <SAN 追加项>`（如 `IP:10.0.0.11`）；输出 `<目录>/mcp-cert.pem` 与 `<目录>/mcp-key.pem`，私钥权限自动 0600；脚本仅依赖 openssl。

## 5. 部署形态

- 直连形态（1.6 现状拓扑）：内置 HTTPS 即可，无需 nginx；
- 反代形态：文档保留「nginx TLS 终结 + 网关 HTTP + `auth.trustedProxies` 白名单」方案，并写明两种形态的取舍（反代形态下网关自身可不开 TLS）。

## 场景

Scenario: 配置证书后以 HTTPS 监听
配置有效证书与私钥启动 HTTP 模式，客户端经 TLS 访问 /healthz 返回 200，/mcp 携带有效 Bearer 完成 initialize 返回 200。
验收：A1

Scenario: 明文请求被拒
对同一 HTTPS 端口发送非 TLS 明文 HTTP 请求，连接失败或握手被拒，未产生任何应用层响应。
验收：A1

Scenario: 未配置证书保持现状
不配置任何 TLS 来源启动，行为与 0.3.x 一致：HTTP 监听、/healthz 200、鉴权行为不变。
验收：A1

Scenario: 配置不完整拒绝启动
仅配置 cert 未配置 key、或证书文件路径不存在时，网关拒绝启动并在错误信息中指明缺失/无效项。
验收：A1
