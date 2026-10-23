#!/usr/bin/env bash
# 一键重置 WSL 测试环境并连跑全部测试
# 背景：本机 WSL 空闲后网络会断、重启后 IP 会变，此脚本每次重头整理。
set -e
cd "$(dirname "$0")/.."

echo "[1/4] 重启 WSL ..."
wsl.exe --shutdown 2>/dev/null || true
sleep 8

echo "[2/4] 启动 sshd 并获取 WSL IP ..."
WIP=$(wsl.exe -u root -- bash -c 'service ssh start >/dev/null 2>&1; hostname -I | cut -d" " -f1' 2>/dev/null | tr -d '\0\r\n')
if [ -z "$WIP" ]; then
  echo "获取 WSL IP 失败"; exit 1
fi
echo "      WSL IP = $WIP"

echo "[3/4] 更新 config.json ..."
sed -i.bak "s/\"host\": \"[0-9.]*\"/\"host\": \"$WIP\"/" config.json
grep -o '"host": "[^"]*"' config.json

echo "[4/4] 跑测试 ..."
node test-direct.js
node test-mcp.js
node test-http.js
echo "全部通过 ✅"
