#!/usr/bin/env bash
# setup-limited-user.sh —— 在目标服务器上创建 AI 专用低权限账号
# 在目标机上以 root 执行；公钥文件内容来自网关侧（本机 ~/.ssh/id_ed25519.pub）
#
# 用法（目标机上）: bash setup-limited-user.sh <公钥文件路径>
#   例：把网关机的公钥先 scp 过来，或直接粘贴内容到临时文件
#
# 脚本做四件事：
#   1. 创建 aiops 用户（禁止密码登录，仅密钥）
#   2. 安装公钥到 /home/aiops/.ssh/authorized_keys
#   3. 写 /etc/sudoers.d/aiops 白名单（只读探查 + 受控服务管理，需 NOPASSWD 的按需删改）
#   4. 打印建议的 config.json servers 条目
#
# 之后在网关 config.json 里把 servers 条目的 username 换成 aiops 即完成切换；
# 网关侧 AI 将无法读写 root 才能碰的文件，破坏半径大幅收敛。
set -euo pipefail

PUBKEY_FILE="${1:-}"
if [ -z "$PUBKEY_FILE" ] || [ ! -f "$PUBKEY_FILE" ]; then
  echo "用法: bash $0 <公钥文件路径>"; exit 1
fi

id aiops >/dev/null 2>&1 || useradd -m -s /bin/bash -p '*' aiops
install -d -m 700 -o aiops -g aiops /home/aiops/.ssh
cat "$PUBKEY_FILE" > /home/aiops/.ssh/authorized_keys
chown aiops:aiops /home/aiops/.ssh/authorized_keys
chmod 600 /home/aiops/.ssh/authorized_keys

cat > /etc/sudoers.d/aiops <<'SUDOEOF'
# AI 专用账号 sudo 白名单：全部强制 --no-pager 防 less 分页器逃逸（!sh 提权）
# 仅只读探查；如需更多命令，逐条追加并保持 --no-pager 尾参
aiops ALL=(root) NOPASSWD: /usr/bin/journalctl * --no-pager, /usr/bin/systemctl status * --no-pager, /usr/bin/systemctl list-units * --no-pager, /usr/bin/systemctl list-timers * --no-pager
SUDOEOF
chmod 440 /etc/sudoers.d/aiops
visudo -c -f /etc/sudoers.d/aiops

echo "=== 完成。网关 config.json 建议条目（替换原 root 条目） ==="
cat <<EOF
{
  "id": "self",
  "name": "目标机（AI 专用低权限）",
  "host": "<本机IP>",
  "port": 22,
  "username": "aiops",
  "privateKeyPath": "<网关侧私钥路径>"
}
EOF
echo "提示: root 权限操作请走 sudo 白名单内命令，或在白名单中按需追加。"
