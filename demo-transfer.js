/**
 * demo-transfer.js —— 文件传输功能测试：
 * 上传（文本/二进制）→ 服务器侧校验 → 下载 → 本地比对 md5 → 安全拦截 → 超限保护
 */
import crypto from "node:crypto";
import { findServer, uploadFile, downloadFile, runCommandRetry, checkBlockedPath } from "./lib.js";

const s = findServer("wsl");
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

// ── 1. 上传文本文件（自动建父目录）──
console.log("== 1. 上传文本文件 ==");
let r = await uploadFile(s, "/opt/ai-demo/note.txt", Buffer.from("AI 上传的配置内容 v1\n").toString("base64"));
console.log(`上传成功: ${r.bytes} 字节, 服务端 md5=${r.md5}`);
let chk = await runCommandRetry(s, "cat /opt/ai-demo/note.txt");
console.log(`服务器侧 cat 验证: ${chk.stdout.trim()}`);

// ── 2. 上传二进制（64KB 随机数据），md5 双端比对 ──
console.log("\n== 2. 上传 64KB 随机二进制 ==");
const bin = crypto.randomBytes(64 * 1024);
r = await uploadFile(s, "/opt/ai-demo/data.bin", bin.toString("base64"), "0644");
const localMd5 = md5(bin);
console.log(`本地  md5=${localMd5}`);
console.log(`远端  md5=${r.md5}  ->  ${r.md5 === localMd5 ? "一致 ✅" : "不一致 ❌"}`);

// ── 3. 下载文本 ──
console.log("\n== 3. 下载文本文件 ==");
let d = await downloadFile(s, "/opt/ai-demo/note.txt");
console.log(`encoding=${d.encoding}, content="${d.content.trim()}"`);

// ── 4. 下载二进制，本地解码后 md5 比对（模拟 AI 侧还原文件）──
console.log("\n== 4. 下载二进制并校验 ==");
d = await downloadFile(s, "/opt/ai-demo/data.bin");
const restored = Buffer.from(d.content, "base64");
console.log(`encoding=${d.encoding}, size=${d.size}, 还原 md5=${md5(restored)}`);
console.log(`与原始 md5 一致: ${md5(restored) === localMd5 ? "✅" : "❌"}`);

// ── 5. 敏感路径拦截 ──
console.log("\n== 5. 敏感路径拦截 ==");
const hit = checkBlockedPath("/root/.ssh/authorized_keys");
console.log(`写 authorized_keys -> ${hit ? `已拦截（${hit}）✅` : "未拦截 ❌"}`);
const hit2 = checkBlockedPath("/etc/shadow");
console.log(`读 /etc/shadow     -> ${hit2 ? "已拦截 ✅" : "未拦截 ❌"}`);

// ── 6. 超限保护 ──
console.log("\n== 6. 下载超限保护（2MB 文件 vs 512KB 上限）==");
await runCommandRetry(s, "dd if=/dev/urandom of=/opt/ai-demo/big.bin bs=1M count=2 2>/dev/null");
try {
  await downloadFile(s, "/opt/ai-demo/big.bin");
  console.log("!! 未拦截 ❌");
} catch (e) {
  console.log(`正确拒绝: ${e.message}`);
}

// ── 7. 清理 ──
await runCommandRetry(s, "rm -rf /opt/ai-demo && echo 已清理");
console.log("\n文件传输测试完成 ✅");
