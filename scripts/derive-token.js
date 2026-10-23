#!/usr/bin/env node
/**
 * derive-token.js —— 由 secret 推导 HMAC 派生 Token（与网关 auth.js 同一实现）
 *
 * 用法：
 *   全局（管理员权限）：node scripts/derive-token.js --secret <master> [--period-hours 24] [--offset 0] [--at <ISO时间>]
 *   每人独立（受 servers 白名单约束）：再加 --id <你的hmacUsers.id>
 *
 * 输出：
 *   无 --id：hmac-<bucket>-<hex>（全局，tokenId = hmac）
 *   有 --id：hmacu-<id>-<bucket>-<hex>（ tokenId = hmacu-<id>，网关按 id 查其 servers 白名单）
 *
 * 直接放入 Authorization: Bearer 头即可。配合 cron/systemd timer 定期生成并更新
 * AI 客户端配置，即可实现自动轮换：两端只保存各自 secret，网络中流转的派生
 * Token 泄露后只在当前时间桶内有效。
 *
 * 示例（每天 00:05 轮换，写入客户端环境文件后重载）：
 *   5 0 * * * token=$(node /opt/ssh-mcp/scripts/derive-token.js --secret "$MASTER") && \\
 *     sed -i "s|Bearer .*|Bearer $token|" /etc/zcode/ssh-mcp-header.conf
 */
import { deriveHmacToken, deriveUserHmacToken, bucketAt } from "../auth.js";

const argv = process.argv.slice(2);
function argOf(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const secret = argOf("--secret");
if (!secret) {
  console.error("用法: node scripts/derive-token.js --secret <master> [--id <hmacUsers.id>] [--period-hours 24] [--offset 0] [--at <ISO时间>]");
  process.exit(1);
}
const userId = argOf("--id");
if (userId != null && !/^[a-z0-9_-]+$/.test(userId)) {
  console.error(`非法 --id: ${userId}（须为小写字母/数字/_/-）`);
  process.exit(1);
}
const periodHours = Number(argOf("--period-hours") ?? 24);
if (!Number.isFinite(periodHours) || periodHours <= 0) {
  console.error(`非法 --period-hours: ${argOf("--period-hours")}`);
  process.exit(1);
}
const offset = Number(argOf("--offset") ?? 0);
if (!Number.isInteger(offset)) {
  console.error(`非法 --offset: ${argOf("--offset")}`);
  process.exit(1);
}
const atArg = argOf("--at");
let atMs = Date.now();
if (atArg) {
  atMs = Date.parse(atArg);
  if (!Number.isFinite(atMs)) {
    console.error(`非法 --at（需要 ISO 8601 时间）: ${atArg}`);
    process.exit(1);
  }
}

const bucket = bucketAt(periodHours, atMs) + offset;
if (bucket < 0) {
  console.error(`桶号为负（${bucket}），请检查 --offset/--at`);
  process.exit(1);
}
const bucketUtc = new Date(bucket * periodHours * 3600 * 1000).toISOString();
console.error(`# period=${periodHours}h bucket=${bucket}（桶起点 UTC ${bucketUtc}）`);
console.log(
  userId != null
    ? deriveUserHmacToken(secret, userId, bucket)
    : deriveHmacToken(secret, bucket)
);
