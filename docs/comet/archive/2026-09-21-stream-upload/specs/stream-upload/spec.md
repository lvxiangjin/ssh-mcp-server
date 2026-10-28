# Capability: stream-upload —— 大文件流式上传

本规格描述归档后网关的流式上传行为。MCP `upload_file`（base64、中小文件）行为不变，仅工具描述更新指引。

## 1. 端点定义

- `POST /upload` 与 `PUT /upload`，二者行为一致（PUT 便于 `curl -T` 直传）。
- 查询参数：
  - `path`（必填）：目标绝对路径（必须以 `/` 开头），父目录自动创建，覆盖写；
  - `server`（可选）：目标服务器 id，省略用默认服务器；
  - `mode`（可选）：八进制权限（如 `0600`、`0644`）。
- 请求体：原始字节流（任意 Content-Type），网关不缓存全量、不落网关磁盘，直接管道至目标机 SFTP 写入流。
- 鉴权与防护：复用 `/mcp` 的 Bearer 鉴权、封禁（429）中间件与审计；401 计入防爆破失败数。
- 成功响应：`200 {"ok":true,"remotePath":"...","bytes":N,"md5":"<远端 md5sum>"}`。
- 失败响应：`400`（path/mode 非法、服务器不存在）、`401`（未授权）、`413`（超上限）、`500`（传输/SSH 错误），均为 `{"error":"..."}`。

## 2. 上限与超时

- 单次上限：`defaults.maxStreamUploadBytes`，默认 `3221225472`（3GiB），config.json 可调。
- 双重校验：请求头 `Content-Length` 超限即刻 413（不建立 SSH 连接）；流式计数超限（无/谎报 Content-Length）中止传输返回 413，并删除远端半截文件。
- `server.requestTimeout = 0`：上传时长不受 Node 默认 300s 限制；头部阶段仍受 headersTimeout（默认 60s）防护。
- 客户端中途断开：中止传输、清理远端半截文件，审计记失败。

## 3. MCP 路径配套修复

- `express.json` 请求体上限改为按 `defaults.maxUploadBytes` 动态计算（`×1.4 + 256KB`），修复 HTTP 模式下默认 100KB 限制导致 `upload_file` 实际不可用的问题；`maxUploadBytes` 本身默认 5MB 不变。
- `upload_file` 工具描述更新：大文件（接近上限及以上）改用网关 `/upload` 端点或服务器侧 wget/scp。

## 4. 审计

- 每次调用（成功或失败）写一条 JSONL：`{ts, ip, tokenId, tool:"upload_stream", args:{remote_path, server?, bytes?}, ok, error?}`；不记录文件内容。

## 5. 部署注意

- 经 Nginx 反代时需为 `/upload` 放开 `client_max_body_size`（如 `0` 不限或按上限设置）；直连/隧道部署无需改动。
- 目标机需预留等量磁盘空间；传输完成后的远端 `md5sum` 耗时与文件大小成正比（3GiB 约数十秒）。
