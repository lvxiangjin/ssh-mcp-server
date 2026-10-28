#!/usr/bin/env bash
# build-linux.sh —— 在 Linux（或 WSL）中把整个网关打包成单文件可执行程序（自带 Node 运行时）
# 产物：dist/ssh-mcp-server-linux，部署时与 config.json 放同一目录即可，服务器无需安装任何东西。
set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${SEA_WORK:-$HOME/sea-build}"
NODE_BIN="$(command -v node)"

echo "[1/6] 准备打包工作目录 $WORK ..."
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
cat > package.json <<'EOF'
{ "name": "sea-build", "version": "1.0.0", "private": true }
EOF

echo "[2/6] 安装打包工具（esbuild + postject，仅打包机需要）..."
npm install --no-audit --no-fund --loglevel=error esbuild postject

echo "[3/6] 打 bundle（全部依赖打进单文件，可选原生模块置为 external，运行时 try/catch 自动降级纯 JS）..."
npx esbuild "$SRC/server.js" \
  --bundle --platform=node --format=cjs \
  --outfile="$WORK/bundle.cjs" \
  --external:cpu-features \
  --external:*.node \
  --log-level=warning

echo "[4/6] 生成 SEA blob ..."
cat > sea-config.json <<EOF
{
  "main": "$WORK/bundle.cjs",
  "output": "$WORK/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
EOF
node --experimental-sea-config sea-config.json

echo "[5/6] 复制 Node 运行时并注入 blob ..."
mkdir -p "$SRC/dist"
OUT="$SRC/dist/ssh-mcp-server-linux"
cp "$NODE_BIN" "$OUT"
npx postject "$OUT" NODE_SEA_BLOB "$WORK/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
chmod +x "$OUT"

echo "[6/6] 完成："
ls -lh "$OUT"
echo "部署方法：scp dist/ssh-mcp-server-linux config.json user@server:/opt/ssh-mcp/ 后直接运行"
