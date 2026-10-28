# Capability: release —— 版本包与发布固化

本规格描述归档后项目的版本发布行为。

## 版本号
- 唯一权威来源：`package.json` 的 `version`；`server.js` 的 MCP Server 元数据 version 必须与之一致（当前 0.3.0）。
- 语义：功能新增进 minor，修复进 patch；发版时同步 `CHANGELOG.md`。

## CHANGELOG
- `CHANGELOG.md` 按版本倒序累积；每个版本小节含：日期、新增/修复/部署说明。v0.3.0 起生效。

## 产物固化
- 每个正式版本：
  - git tag `v<版本>`（注解：源码提交、产物 SHA256、构建环境），指向发布提交；
  - 服务器 `/opt/ssh-mcp/releases/ssh-mcp-server-linux-v<版本>`（SEA 二进制副本）与 `SHA256SUMS`；
  - 生产运行路径 `/opt/ssh-mcp/ssh-mcp-server-linux` 不受影响；回滚即从 releases 拷回对应版本。
- 二进制不进 git；从 tag 源码 `bash scripts/build-linux.sh` 可重建（构建环境：WSL Ubuntu Node 22）。

## 发布流程（人工，本版起生效）
1. main 上确认功能验收通过 → package.json/CHANGELOG 更新版本；
2. 归档合并到 main → 打注解 tag → `git push origin main v<版本>`；
3. 构建产物 → 拷入服务器 releases/ → 追加 SHA256SUMS → 部署到生产路径并重启验证。
