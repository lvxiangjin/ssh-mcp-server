/**
 * check-v04.mjs —— v0.4.0 新特性的纯函数快速检查（无网络、无端口、秒级完成）
 * 供 Comet Runtime verification_checks 与开发期快速回归使用：
 *   node scripts/check-v04.mjs
 * 覆盖：黑名单/确认清单匹配矩阵、IP/CIDR 匹配、双维防爆破限流器行为。
 */
import assert from "node:assert/strict";
import { checkBlocked, checkConfirm } from "../lib.js";
import { createRateLimiter, matchIpEntry } from "../auth.js";

let passed = 0;
const t = (label, fn) => {
  fn();
  passed++;
  console.log(`== ${label} ✓ ==`);
};

// ---------- 黑名单（内置最低限度 + config 合并） ----------
t("黑名单：根分区变体命中（含引号/包裹），目录级不误伤", () => {
  for (const cmd of ['rm -rf /', 'bash -c "rm -rf /"', "sh -c 'rm -rf /'", "rm -fr /*", "rm -f -r /"]) {
    assert.ok(checkBlocked(cmd), `应命中黑名单: ${cmd}`);
  }
  assert.ok(!checkBlocked("rm -rf /tmp/build"));
  assert.ok(!checkBlocked("rm file.txt"));
});

// ---------- 确认清单 ----------
t("确认清单：高危形态命中，普通命令放行", () => {
  for (const cmd of ["rm -rf /", 'rm -rf "/tmp/demo"', "find / -delete", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda", "shred /dev/sdb", "echo x > /etc/shadow"]) {
    assert.ok(checkConfirm(cmd), `应命中确认清单: ${cmd}`);
  }
  for (const cmd of ["df -h", "ls -la /opt", "rm -rf /tmp/build", "echo hi"]) {
    assert.ok(!checkConfirm(cmd), `不应命中确认清单: ${cmd}`);
  }
});

// ---------- IP/CIDR 匹配 ----------
t("matchIpEntry：精确/CIDR/IPv4-mapped/IPv6", () => {
  assert.ok(matchIpEntry("10.0.0.11", ["10.0.0.0/24"]));
  assert.ok(matchIpEntry("127.0.0.1", ["127.0.0.0/8"]));
  assert.ok(!matchIpEntry("10.0.1.1", ["10.0.0.0/24"]));
  assert.ok(matchIpEntry("::ffff:10.0.0.11", ["10.0.0.0/24"])); // mapped 等价
  assert.ok(matchIpEntry("::1", ["::1"]));
  assert.ok(matchIpEntry("fd00::1234", ["fd00::/16"]));
  assert.ok(!matchIpEntry("fd01::1234", ["fd00::/16"]));
  assert.ok(!matchIpEntry("unknown", ["127.0.0.0/8"]));
});

// ---------- 双维限流器 ----------
const RL = { windowMs: 60_000, maxFails: 3, banMs: 1000 };

t("限流器：同键达阈值封禁，仅该键 429，其他键不受影响", () => {
  const l = createRateLimiter(RL);
  l.recordFailure("1.1.1.1", "fpA");
  l.recordFailure("1.1.1.1", "fpA");
  assert.equal(l.isBanned("1.1.1.1", "fpA").banned, false); // 第 3 次前不封
  l.recordFailure("1.1.1.1", "fpA");
  assert.equal(l.isBanned("1.1.1.1", "fpA").banned, true); // 同键第 3 次后封
  assert.equal(l.isBanned("1.1.1.1", "fpB").banned, false); // 其他键不受影响
  assert.equal(l.isBanned("2.2.2.2", "fpA").banned, false); // 其他 IP 不受影响
});

t("限流器：跨键累计达 maxFails×3 封整个 IP（含任意键）", () => {
  const l = createRateLimiter(RL); // maxFails=3 → 聚合阈值 9
  for (let i = 0; i < 9; i++) l.recordFailure("3.3.3.3", `fp${i}`); // 9 个不同键
  assert.equal(l.isBanned("3.3.3.3", "anything").banned, true);
  assert.equal(l.isBanned("3.3.3.3", "").banned, true);
});

t("限流器：豁免网段永不封禁", () => {
  const l = createRateLimiter(RL, ["127.0.0.0/8"]);
  for (let i = 0; i < 30; i++) l.recordFailure("127.0.0.1", `fp${i}`);
  assert.equal(l.isBanned("127.0.0.1", "fp0").banned, false);
});

t("限流器：封禁期内请求不延长封禁（到点即解）", () => {
  const fast = { windowMs: 60_000, maxFails: 1, banMs: 50 };
  const l = createRateLimiter(fast);
  l.recordFailure("4.4.4.4", "fp");
  assert.equal(l.isBanned("4.4.4.4", "fp").banned, true);
  return new Promise((resolve) => {
    setTimeout(() => {
      // 封禁期内的持续请求不得延长
      const until = Date.now() + 120;
      while (Date.now() < until) l.isBanned("4.4.4.4", "fp");
      setTimeout(() => {
        assert.equal(l.isBanned("4.4.4.4", "fp").banned, false);
        resolve();
      }, 60);
    }, 60);
  });
});

const results = await Promise.allSettled([]);
console.log(`\ncheck-v04: ${passed} 组检查全部通过 ✅`);
