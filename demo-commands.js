/**
 * demo-commands.js —— 演示：AI 通过网关在 Linux 上执行各类命令
 */
import { findServer, runCommandRetry } from "./lib.js";

const s = findServer("wsl");

const demos = [
  ["系统信息", "grep PRETTY /etc/os-release && uname -r"],
  ["资源占用", "free -h | head -2 && df -h / | tail -1"],
  ["当前身份", "whoami && pwd"],
  ["真实写/读/删文件", 'echo "这条内容由 AI 于 $(date +%T) 通过 SSH 写入" > /tmp/ai-demo.txt && cat /tmp/ai-demo.txt && rm /tmp/ai-demo.txt && echo 已删除'],
  ["进程 TOP3", "ps aux --sort=-%cpu | head -4 | awk '{printf \"%-8s %5s%% %s\\n\", $1, $3, $11}'"],
  ["管道+文本处理", "ls /etc | wc -l && ls /etc | grep -c '^systemd'"],
  ["退出码透传", "ls /不存在的路径; echo 退出码=$?"],
];

for (const [title, cmd] of demos) {
  const r = await runCommandRetry(s, cmd);
  console.log(`──── ${title} ────`);
  console.log(`$ ${cmd}`);
  if (!r.ok) console.log(`执行失败: ${r.error}`);
  else console.log((r.stdout || r.stderr).trim() || "(无输出)");
  console.log("");
}
