/**
 * test-direct.js —— 绕过 MCP 协议，直接测试 SSH 执行核心逻辑
 */
import { findServer, runCommand, checkBlocked } from "./lib.js";

const s = findServer();

console.log("== 测试 1: 普通命令 ==");
let r = await runCommand(s, "echo hello from $(hostname) && df -h / | tail -1");
console.log(`ok=${r.ok} exit=${r.exitCode}`);
console.log(r.stdout);

console.log("\n== 测试 2: 错误退出码 + stderr ==");
r = await runCommand(s, "echo to-stderr >&2; exit 42");
console.log(`ok=${r.ok} exit=${r.exitCode}`);
console.log(`stderr: ${r.stderr.trim()}`);

console.log("\n== 测试 3: 危险命令拦截 ==");
const blocked = checkBlocked("rm -rf / --no-preserve-root");
console.log(blocked ? `已拦截，命中规则: ${blocked}` : "!! 未拦截，有问题");

console.log("\n== 测试 4: 不存在的服务器 ==");
try {
  findServer("no-such-server");
} catch (e) {
  console.log(`正确抛错: ${e.message}`);
}
