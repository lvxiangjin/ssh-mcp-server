#!/usr/bin/env bash
# gen-cert.sh —— 生成自签 TLS 证书对（内置 HTTPS 用，零第三方依赖，仅需 openssl）
# 用法：
#   scripts/gen-cert.sh                          # 输出到 ./tls/，CN=ssh-mcp-gateway，SAN 含本机 IP
#   scripts/gen-cert.sh -o /opt/ssh-mcp/tls -n 网关名 -a IP:10.0.0.11 -a DNS:mcp.example.com
# 产物：mcp-cert.pem / mcp-key.pem（私钥 0600）
set -euo pipefail

OUT="./tls"
CN="ssh-mcp-gateway"
DAYS=825
EXTRA_SAN=()

while getopts "o:n:a:d:h" opt; do
  case "$opt" in
    o) OUT="$OPTARG" ;;
    n) CN="$OPTARG" ;;
    a) EXTRA_SAN+=("$OPTARG") ;;
    d) DAYS="$OPTARG" ;;
    h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数，-h 查看用法" >&2; exit 1 ;;
  esac
done

command -v openssl >/dev/null || { echo "需要 openssl" >&2; exit 1; }
mkdir -p "$OUT"

# 自动收集本机非回环 IPv4 作为 SAN（直连场景浏览器/客户端校验常用）
SAN="DNS:${CN},DNS:localhost,IP:127.0.0.1"
for ip in $(hostname -I 2>/dev/null || true); do
  SAN="${SAN},IP:${ip}"
done
for s in "${EXTRA_SAN[@]:-}"; do
  [ -n "$s" ] && SAN="${SAN},${s}"
done

CERT="$OUT/mcp-cert.pem"
KEY="$OUT/mcp-key.pem"

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -keyout "$KEY" -out "$CERT" -days "$DAYS" -nodes \
  -subj "/CN=${CN}" \
  -addext "subjectAltName=${SAN}" 2>/dev/null
chmod 600 "$KEY"

echo "已生成自签证书（${DAYS} 天，SAN: ${SAN}）："
echo "  证书: $CERT"
echo "  私钥: $KEY （权限 600）"
echo ""
echo "网关启用方式（二选一）："
echo "  环境变量: SSH_MCP_TLS_CERT=$CERT SSH_MCP_TLS_KEY=$KEY"
echo "  config.json: \"tls\": { \"cert\": \"$CERT\", \"key\": \"$KEY\" }"
echo "自签证书需客户端信任或在测试工具中关闭校验（curl -k）。"
