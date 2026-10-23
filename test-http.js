/**
 * test-http.js —— HTTP 模式端到端测试
 *
 * 覆盖（A1b/A2-A7 鉴权场景不依赖 SSH 目标，可随时跑；完整流程场景需默认服务器可达）：
 *   A1 向后兼容：仅 SSH_MCP_TOKEN 部署行为不变；无任何凭据拒绝启动
 *   A2 多 Token 与过期/禁用
 *   A3 HMAC 派生 Token：当前桶通过、越界桶 401、篡改 401（经 scripts/derive-token.js CLI 验证）
 *   A4 防爆破：连续失败触发 429 + Retry-After，封禁期内正确 Token 也被拒，到期自动解除
 *   A5 审计日志：开启后 JSONL 记录工具调用与鉴权失败；429 不记录；不记录 Token 原值
 *   A6 鉴权失败响应统一 401，不区分原因
 *   A7 审计默认关闭：不创建目录不写文件
 */
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertPathAllowed, checkBlockedPath, normalizeRemotePath, validateCoreConfig } from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { SSH_MCP_TOKEN: _DROP, SSH_MCP_CONFIG: _DROP2, SSH_MCP_TRUST_PROXY: _DROP3, ...CLEAN_ENV } = process.env; // 测试显式控制凭据与环境
const HEX = (c) => c.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`== ${label} ✓ ==`);
  } else {
    failures++;
    console.log(`!! ${label} ✗ !!`);
  }
}

function startServer(port, { env = {}, cwd = __dirname } = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd,
    env: {
      ...CLEAN_ENV,
      SSH_MCP_TRANSPORT: "http",
      SSH_MCP_HOST: "127.0.0.1",
      SSH_MCP_PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  return child;
}

async function waitReady(base, child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode != null) throw new Error(`server 提前退出（code=${child.exitCode}）`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error("server 启动超时");
}

/** 裸 HTTP 请求（用于 401/429 断言，不走 MCP 客户端） */
async function rawMcp(base, token) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token != null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
}

async function mcpConnect(base, token) {
  const client = new Client({ name: "ssh-mcp-http-test", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

function stop(child) {
  try { child.kill(); } catch { /* ignore */ }
}
const runScript = (args) =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { encoding: "utf8" });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? res(out.trim()) : rej(new Error(err || `exit ${code}`))));
  });

let rejectPort = 18100;
async function expectStartupReject(configValue, expected, label, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-reject-"));
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(configValue));
  let stderr = "";
  const child = startServer(rejectPort++, { env: { SSH_MCP_CONFIG: cfgPath, ...env } });
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((res) => child.on("exit", (c) => res(c)));
  check(code !== 0 && stderr.includes(expected), label);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 尽力清理 */ }
}

// ============ A0：纯函数安全边界 ============
{
  check(normalizeRemotePath("/tmp/../etc/passwd") === "/etc/passwd", "A0 路径规范化处理 ..");
  check(!!checkBlockedPath("/tmp/../etc/passwd"), "A0 敏感路径黑名单匹配规范化路径");
  let relativeRejected = false;
  try { assertPathAllowed({ allowedFileRoots: ["/tmp"] }, "tmp/x"); } catch { relativeRejected = true; }
  check(relativeRejected, "A0 相对路径拒绝");
  let escapedRejected = false;
  try { assertPathAllowed({ allowedFileRoots: ["/tmp"] }, "/tmp/../etc/passwd"); } catch { escapedRejected = true; }
  check(escapedRejected, "A0 allowedFileRoots 拒绝词法逃逸");
  const coreErrors = validateCoreConfig({
    servers: [
      { id: "dup", host: "a", username: "u", privateKeyPath: "k" },
      { id: "dup", host: "b", username: "u", privateKeyPath: "k" },
    ],
    defaults: { serverId: "missing", maxConcurrentSsh: 0 },
  });
  check(coreErrors.some((e) => e.includes("服务器 id 重复")) && coreErrors.some((e) => e.includes("defaults.serverId")), "A0 核心配置校验发现重复 id 与错误默认服务器");
}

// ============ A1a：无任何凭据 → 拒绝启动 ============
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-nocred-"));
  const cfg = path.join(tmp, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ servers: [], defaults: {} }));
  let stderr = "";
  const child = startServer(18090, { env: { SSH_MCP_CONFIG: cfg } });
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((res) => child.on("exit", (c) => res(c)));
  check(code !== 0 && stderr.includes("拒绝启动"), "A1a 无任何凭据时拒绝启动");
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* Windows 句柄延迟释放，尽力清理 */ }
}

// ============ A1c：启动配置校验 ============
await expectStartupReject(
  {
    servers: [
      { id: "dup", host: "127.0.0.1", username: "u", privateKeyPath: "k" },
      { id: "dup", host: "127.0.0.1", username: "u", privateKeyPath: "k" },
    ],
    defaults: {},
  },
  "服务器 id 重复",
  "A1c 重复 server id 拒绝启动",
  { SSH_MCP_TOKEN: "token" }
);
await expectStartupReject(
  { servers: [], defaults: { serverId: "missing" } },
  "defaults.serverId",
  "A1c 错误 default server 拒绝启动",
  { SSH_MCP_TOKEN: "token" }
);
await expectStartupReject(
  { servers: [], defaults: { maxDownloadBytes: 0 } },
  "defaults.maxDownloadBytes",
  "A1c 非法资源上限拒绝启动",
  { SSH_MCP_TOKEN: "token" }
);
await expectStartupReject(
  {
    servers: [],
    defaults: {},
    auth: { tokens: [{ id: "same", token: HEX("1") }, { id: "same", token: HEX("2") }] },
  },
  "Token id 重复",
  "A1c 重复 token id 拒绝启动"
);

// ============ A1b：仅 SSH_MCP_TOKEN（向后兼容） ============
{
  const base = "http://127.0.0.1:18080";
  const child = startServer(18080, { env: { SSH_MCP_TOKEN: "legacy-token-123" } });
  try {
    await waitReady(base, child);
    const r401 = await rawMcp(base, "wrong-token");
    const body = await r401.json();
    check(r401.status === 401 && body.error?.code === -32001, "A1b 旧部署错误 Token 401");
    const c = await mcpConnect(base, "legacy-token-123");
    const r = await c.callTool({ name: "list_servers" });
    check(!r.isError && String(r.content?.[0]?.text).length > 0, "A1b 旧部署正确 Token 可调用（list_servers）");
    await c.close();
  } catch (e) {
    failures++;
    console.log(`!! A1b 异常: ${e.message}`);
  } finally {
    stop(child);
  }
}

// ============ A2/A3/A4/A5/A6：多 Token + HMAC + 防爆破 + 审计 ============
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-auth-"));
  const auditDir = path.join(tmp, "audit");
  const aliceToken = await runScript([path.join(__dirname, "scripts", "gen-token.js")]);
  check(/^[0-9a-f]{64}$/.test(aliceToken), "A2 gen-token.js 生成 64 位 hex Token");

  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    servers: [],
    defaults: {},
    auth: {
      tokens: [
        { id: "alice", token: aliceToken, note: "valid" },
        { id: "bob", token: HEX("b"), expiresAt: "2020-01-01T00:00:00Z", note: "expired" },
        { id: "carol", token: HEX("c"), disabled: true, note: "disabled" },
      ],
      hmac: { secret: "hmac-master-secret-for-test", periodHours: 24, graceBuckets: 1 },
      rateLimit: { windowMs: 60_000, maxFails: 8, banMs: 3000 },
    },
    audit: { enabled: true, dir: auditDir, resultChars: 0 },
  }));

  const base = "http://127.0.0.1:18081";
  const child = startServer(18081, { env: { SSH_MCP_CONFIG: cfgPath } });
  let authFailedExpected = 0;
  try {
    await waitReady(base, child);

    // A6：不同失败原因的响应完全一致（无头 / 错误 / 过期 / 禁用）→ 4 次 401
    const bodies = new Set();
    for (const t of [null, "totally-wrong", HEX("b"), HEX("c")]) {
      const r = await rawMcp(base, t);
      const b = await r.json();
      bodies.add(JSON.stringify({ status: r.status, code: b.error?.code, msg: b.error?.message }));
      check(r.status === 401, `A6 无效凭据 401（${t === null ? "无头" : t.slice(0, 8) + "…"}）`);
    }
    authFailedExpected += 4;
    check(bodies.size === 1, "A6 各失败原因响应体完全一致（不泄露原因）");

    // A2：有效 Token 可调用
    const alice = await mcpConnect(base, aliceToken);
    const lr = await alice.callTool({ name: "list_servers" });
    check(!lr.isError, "A2 有效 Token（alice）调用 list_servers 成功");
    await alice.close();

    // A3：HMAC 派生 Token（经 derive-token.js CLI，验证与网关同源实现）
    const derive = (offset) =>
      runScript([
        path.join(__dirname, "scripts", "derive-token.js"),
        "--secret", "hmac-master-secret-for-test",
        ...(offset ? ["--offset", String(offset)] : []),
      ]);
    const curToken = await derive();
    check(/^hmac-\d+-[0-9a-f]{64}$/.test(curToken), "A3 derive-token.js 输出格式正确");

    // A3：宽容窗边界 —— 前一桶（cur-1）与时钟超前方向（cur+1）都应通过
    check((await rawMcp(base, await derive(-1))).status === 200, "A3 前一桶（cur-1，宽容窗内）通过");
    check((await rawMcp(base, await derive(1))).status === 200, "A3 后一桶（cur+1，时钟超前宽容）通过");
    const hmacClient = await mcpConnect(base, curToken);
    await hmacClient.callTool({ name: "list_servers" });
    await hmacClient.close();
    check(true, "A3 当前桶派生 Token 通过鉴权");

    // A3：篡改 hex 一位 → 401；越界桶（cur-2，超出 ±1）→ 401
    const tampered = curToken.slice(0, -1) + (curToken.endsWith("0") ? "1" : "0");
    authFailedExpected++;
    check((await rawMcp(base, tampered)).status === 401, "A3 篡改派生 Token hex 部分被拒");
    authFailedExpected++;
    check((await rawMcp(base, await derive(-2))).status === 401, "A3 越界桶派生 Token（cur-2）401");

    // A4（v2 双维计数）：同键（同 IP + 同错误 Token）失败达 maxFails=8 → 键级封禁
    let fillerAll401 = true;
    for (let i = 0; i < 8; i++) {
      authFailedExpected++;
      if ((await rawMcp(base, "filler-same")).status !== 401) fillerAll401 = false;
    }
    check(fillerAll401, "A4 同键前 8 次失败均 401（计满当次不跳 429）");
    const keyBanned = await rawMcp(base, "filler-same"); // 键级封禁 → 429（429 不计数、不审计）
    const retryAfter = Number(keyBanned.headers.get("retry-after"));
    check(keyBanned.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0, "A4 键级封禁返回 429 + Retry-After");
    // 键级封禁只影响被试错的键：正确 Token（不同键）不受影响
    const duringKeyBan = await mcpConnect(base, aliceToken);
    const dkb = await duringKeyBan.callTool({ name: "list_servers" });
    check(!dkb.isError, "A4 键级封禁不影响其他键（正确 Token 正常使用）");
    await duringKeyBan.close();

    // A4（v2）：跨键累计达 maxFails×3=24 → 整 IP 封禁（含正确 Token 一并 429）
    // 当前聚合：A6 的 4 + 篡改 1 + 越界 1 + filler-same 8 = 14，再补 10 个不同键
    for (let i = 0; i < 10; i++) {
      await rawMcp(base, `mass-${i}`);
      authFailedExpected++;
    }
    const ipBanned = await rawMcp(base, "one-more"); // 聚合已到 24 → 整 IP 429（不计数）
    check(ipBanned.status === 429 && Number(ipBanned.headers.get("retry-after")) > 0, "A4 跨键累计达阈值封整个 IP（429）");
    let bannedValid = false;
    try { await mcpConnect(base, aliceToken); } catch { bannedValid = true; }
    check(bannedValid, "A4 整 IP 封禁期内正确 Token 也被 429 拒绝");

    // A4：封禁到期（banMs=3000）自动解除
    await sleep(3300);
    const alice2 = await mcpConnect(base, aliceToken);
    const lr2 = await alice2.callTool({ name: "list_servers" });
    check(!lr2.isError, "A4 封禁到期后自动解除");
    await alice2.close();

    // A3：解除封禁后篡改 Token 仍被拒（独立于封禁逻辑）
    authFailedExpected++;
    check((await rawMcp(base, tampered)).status === 401, "A3 解除封禁后篡改 Token 仍被拒");

    // A5：审计内容 —— authFailedExpected 条鉴权失败，429 不产生审计，工具调用记身份与脱敏参数
    await sleep(400); // 审计为异步追加写入，等待写链路排空再断言
    const auditFile = fs.readdirSync(auditDir).find((f) => f.startsWith("audit-") && f.endsWith(".log"));
    const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const authFails = lines.filter((e) => e.error?.startsWith("auth-failed:"));
    const toolCalls = lines.filter((e) => e.tool != null);
    check(lines.length === authFails.length + toolCalls.length, "A5 审计记录均为完整 JSONL");
    check(authFails.length === authFailedExpected, `A5 鉴权失败审计 ${authFails.length}/${authFailedExpected} 条（429 未记录）`);
    check(authFails.every((e) => /^invalid-[0-9a-f]{8}$/.test(e.tokenId)), "A5 失败记录只含 8 位指纹");
    check(toolCalls.some((e) => e.tokenId === "alice" && e.tool === "list_servers" && e.ok === true), "A5 工具调用记录 Token 身份");
    check(toolCalls.some((e) => e.tokenId === "hmac"), "A5 派生 Token 调用记录身份 hmac");
    check(toolCalls.every((e) => e.result == null), "A5 resultChars=0 时不记录 result（关闭路径）");
    const raw = fs.readFileSync(path.join(auditDir, auditFile), "utf8");
    check(!raw.includes(aliceToken) && !raw.includes("content_base64"), "A5 审计不记 Token 原值/不记文件内容字段");
  } catch (e) {
    failures++;
    console.log(`!! 场景C 异常: ${e.message}`);
  } finally {
    stop(child);
  }
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* Windows 句柄延迟释放，尽力清理 */ }
}

// ============ Token 级服务器 ACL：白名单过滤/越权拒绝/默认解析/不受限兼容/启动校验（需默认主机可达） ============
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-acl-"));
  // 双服务器条目指向同一台真实主机，仅 id 不同——用于验证 ACL 而非主机差异
  const baseCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const h = baseCfg.servers[0];
  const mk = (id) => ({ id, name: id, host: h.host, port: h.port, username: h.username, privateKeyPath: h.privateKeyPath });
  baseCfg.servers = [mk("srv-a"), mk("srv-b")];
  baseCfg.defaults = { ...(baseCfg.defaults ?? {}), serverId: "srv-a" };
  baseCfg.auth = {
    tokens: [
      { id: "alice", token: HEX("a"), servers: ["srv-b"] },  // 受限：仅 srv-b（白名单首个 ≠ 全局默认 srv-a，用于验证默认解析）
      { id: "boss", token: HEX("f") },                        // 不受限
    ],
  };
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(baseCfg));

  const base = "http://127.0.0.1:18085";
  const child = startServer(18085, { env: { SSH_MCP_CONFIG: cfgPath } });
  try {
    await waitReady(base, child);

    const alice = await mcpConnect(base, HEX("a"));
    const lsA = await alice.callTool({ name: "list_servers" });
    const lsAText = String(lsA.content?.[0]?.text);
    check(lsAText.includes("srv-b") && !lsAText.includes("srv-a"), "A1 受限 list_servers 仅见白名单内服务器（不泄露 srv-a）");

    // A1：未传 server → 默认取白名单首个（srv-b），断言结果首行含 server: srv-b
    const defRun = await alice.callTool({ name: "run_command", arguments: { command: "echo ACL_DEFAULT_OK" } });
    check(
      !defRun.isError && String(defRun.content?.[0]?.text).includes("server: srv-b"),
      "A1 受限 Token 未传 server → 默认落在白名单首个（srv-b）"
    );

    const denyRun = await alice.callTool({ name: "run_command", arguments: { command: "echo x", server: "srv-a" } });
    check(denyRun.isError && String(denyRun.content?.[0]?.text).includes("无权访问指定的服务器"), "A1 越权 run_command（srv-a）→ 拒绝");
    const denyJob = await alice.callTool({ name: "check_job", arguments: { job_id: "aaaaaaaaaaaa", server: "srv-a" } });
    check(denyJob.isError && String(denyJob.content?.[0]?.text).includes("无权访问指定的服务器"), "A1 越权 check_job（srv-a）→ 拒绝");
    const denyUp = await alice.callTool({
      name: "upload_file",
      arguments: { remote_path: "/tmp/x", content_base64: Buffer.from("x").toString("base64"), server: "srv-a" },
    });
    check(denyUp.isError && String(denyUp.content?.[0]?.text).includes("无权访问指定的服务器"), "A1 越权 upload_file（srv-a）→ 拒绝");

    // A3：不受限 Token 行为完全不变
    const boss = await mcpConnect(base, HEX("f"));
    const lsB = await boss.callTool({ name: "list_servers" });
    const lsBText = String(lsB.content?.[0]?.text);
    check(lsBText.includes("srv-a") && lsBText.includes("srv-b"), "A3 不受限 Token list_servers 见全部服务器");
    const bossRun = await boss.callTool({ name: "run_command", arguments: { command: "echo BOSS_OK", server: "srv-a" } });
    check(!bossRun.isError && String(bossRun.content?.[0]?.text).includes("BOSS_OK"), "A3 不受限 Token 指定 srv-a 执行成功");
    await boss.close();
    await alice.close();

    // A3：/upload 与 /download 端点同样强制（越权目标是 srv-a）
    const up403 = await fetch(`${base}/upload?path=${encodeURIComponent("/tmp/x")}&server=${encodeURIComponent("srv-a")}`, {
      method: "POST", headers: { authorization: `Bearer ${HEX("a")}` }, body: "x",
    });
    check(up403.status === 403, "A3 /upload 越权 server → 403");
    const dl403 = await fetch(`${base}/download?path=${encodeURIComponent("/tmp/x")}&server=${encodeURIComponent("srv-a")}`, {
      headers: { authorization: `Bearer ${HEX("a")}` },
    });
    check(dl403.status === 403, "A3 /download 越权 server → 403");
  } catch (e) {
    failures++;
    console.log(`!! ACL 场景异常: ${e.message}`);
  } finally {
    stop(child);
  }

  // A4：token.servers 引用未定义 id → 拒绝启动
  {
    const badCfg = path.join(tmp, "config-bad.json");
    fs.writeFileSync(badCfg, JSON.stringify({
      servers: [mk("srv-a")],
      defaults: {},
      auth: { tokens: [{ id: "x", token: HEX("1"), servers: ["nope"] }] },
    }));
    let stderr = "";
    const bad = startServer(18086, { env: { SSH_MCP_CONFIG: badCfg } });
    bad.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((res) => bad.on("exit", (c) => res(c)));
    check(code !== 0 && stderr.includes("引用未定义的服务器 id"), "A4 servers 引用未定义 id → 拒绝启动");
  }

  // A4b：hmacUsers 缺 secret / periodHours 非法 / servers 引用未定义 id → 拒绝启动
  {
    const badCfg = path.join(tmp, "config-hmaccfg-bad.json");
    fs.writeFileSync(badCfg, JSON.stringify({
      servers: [mk("srv-a")],
      defaults: {},
      auth: { hmacUsers: [{ id: "emp", servers: ["srv-a"] }, { id: "bad ph", secret: "s", periodHours: -1 }] },
    }));
    let stderr = "";
    const bad = startServer(18087, { env: { SSH_MCP_CONFIG: badCfg } });
    bad.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((res) => bad.on("exit", (c) => res(c)));
    check(code !== 0 && stderr.includes("hmacUsers"), "A4 hmacUsers 配置非法 → 拒绝启动");
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 尽力清理 */ }
}

// ============ 每人独立 HMAC（hmacUsers）：派生/白名单/与全局并存（需默认主机可达） ============
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-hmacu-"));
  const baseCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const h = baseCfg.servers[0];
  baseCfg.servers = [h];
  baseCfg.defaults = { ...(baseCfg.defaults ?? {}) };
  baseCfg.auth = {
    hmac: { secret: "global-hmac-secret-for-test-0123456789abcdef" },
    hmacUsers: [{ id: "emp", secret: "emp-secret-0123456789abcdef-0123456789", servers: ["self"] }],
  };
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(baseCfg));

  const base = "http://127.0.0.1:18088";
  const child = startServer(18088, { env: { SSH_MCP_CONFIG: cfgPath } });
  try {
    await waitReady(base, child);
    const derive = (extra) =>
      runScript([
        path.join(__dirname, "scripts", "derive-token.js"),
        "--secret", extra.secret, ...(extra.id ? ["--id", extra.id] : []),
      ]);

    const empTok = await derive({ secret: "emp-secret-0123456789abcdef-0123456789", id: "emp" });
    check(/^hmacu-emp-\d+-[0-9a-f]{64}$/.test(empTok), "A2 每人派生 Token 格式 hmacu-emp-…");
    const emp = await mcpConnect(base, empTok);
    const ls = await emp.callTool({ name: "list_servers" });
    check(String(ls.content?.[0]?.text).includes("self") && !String(ls.content?.[0]?.text).includes("其他"), "A2 hmacu list_servers 正常");
    const run = await emp.callTool({ name: "run_command", arguments: { command: "echo HMACU_OK" } });
    check(!run.isError && String(run.content?.[0]?.text).includes("HMACU_OK"), "A2 hmacu 后台外 run_command 执行成功");
    await emp.close();

    const wrongSecret = await derive({ secret: "global-hmac-secret-for-test-0123456789abcdef", id: "emp" });
    const wr = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${wrongSecret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    check(wr.status === 401, "A3 用全局 secret 冒充 emp 的 hmacu token → 401");

    const globalTok = await derive({ secret: "global-hmac-secret-for-test-0123456789abcdef" });
    const gr = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${globalTok}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    check(gr.status === 200, "A3 全局 hmac Token 仍可用（向后兼容）");
  } catch (e) {
    failures++;
    console.log(`!! hmacUsers 场景异常: ${e.message}`);
  } finally {
    stop(child);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 尽力清理 */ }
}
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-noaudit-"));
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    servers: [],
    defaults: {},
    auth: { tokens: [{ id: "solo", token: HEX("d") }] },
    audit: { enabled: false, dir: path.join(tmp, "audit") },
  }));
  const base = "http://127.0.0.1:18082";
  const child = startServer(18082, { env: { SSH_MCP_CONFIG: cfgPath }, cwd: tmp });
  try {
    await waitReady(base, child);
    await rawMcp(base, "wrong"); // 一次失败
    const c = await mcpConnect(base, HEX("d"));
    await c.callTool({ name: "list_servers" }); // 一次成功
    await c.close();
    await sleep(300);
    check(!fs.existsSync(path.join(tmp, "audit")) && !fs.existsSync(path.join(tmp, "logs")), "A7 审计关闭时不创建任何目录/文件");
  } catch (e) {
    failures++;
    console.log(`!! A7 异常: ${e.message}`);
  } finally {
    stop(child);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* Windows 句柄延迟释放，尽力清理 */ }
}

// ============ 流式上传上限：Content-Length 预检 413 / path 校验 400（不依赖 SSH） ============
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-scap-"));
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    servers: [],
    defaults: { maxStreamUploadBytes: 1024 }, // 上限压到 1KB 便于触发
    blockedPathPatterns: ["authorized_keys$"],
    auth: { tokens: [{ id: "solo", token: HEX("e") }] },
  }));
  const base = "http://127.0.0.1:18083";
  const child = startServer(18083, { env: { SSH_MCP_CONFIG: cfgPath } });
  try {
    await waitReady(base, child);
    const post = (qs, body) => fetch(`${base}/upload${qs}`, {
      method: "POST",
      headers: { authorization: `Bearer ${HEX("e")}` },
      body,
    });
    const r413 = await post(`?path=${encodeURIComponent("/tmp/x.bin")}`, Buffer.alloc(64 * 1024));
    check(r413.status === 413, "A3 Content-Length 超上限即刻 413（不触达 SSH）");
    const r400 = await post(`?path=${encodeURIComponent("relative/path")}`, "x");
    check(r400.status === 400, "A3 非绝对路径 → 400");
    const rMode = await post(`?path=${encodeURIComponent("/tmp/x.bin")}&mode=abc`, "x");
    check(rMode.status === 400, "A3 非法 mode → 400");
    const rBlk = await post(`?path=${encodeURIComponent("/root/.ssh/authorized_keys")}`, "x");
    check(rBlk.status === 400 && String((await rBlk.json()).error).includes("安全策略拦截"), "A3 敏感路径黑名单同样拦截 /upload");
  } catch (e) {
    failures++;
    console.log(`!! A3 异常: ${e.message}`);
  } finally {
    stop(child);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 尽力清理 */ }
}

// ============ A3-流中：chunked 无 Content-Length 超限 → 413 且远端无残片（需默认服务器可达） ============
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-smid-"));
  const baseCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  baseCfg.defaults = { ...(baseCfg.defaults ?? {}), maxStreamUploadBytes: 1024 };
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(baseCfg));
  const base = "http://127.0.0.1:18084";
  const child = startServer(18084, { env: { SSH_MCP_TOKEN: "mid-stream-token", SSH_MCP_CONFIG: cfgPath } });
  try {
    await waitReady(base, child);
    const c = await mcpConnect(base, "mid-stream-token");
    await c.callTool({
      name: "run_command",
      arguments: { command: "printf ORIGINAL_CONTENT > /tmp/ssh-mcp-midstream.bin" },
    });
    async function* chunks() { for (let i = 0; i < 8; i++) yield Buffer.alloc(1024, 120); }
    const res = await fetch(`${base}/upload?path=${encodeURIComponent("/tmp/ssh-mcp-midstream.bin")}`, {
      method: "POST",
      headers: { authorization: `Bearer mid-stream-token` },
      body: chunks(),
      duplex: "half", // chunked 传输：无 Content-Length，上限只能靠流式计数
    });
    check(res.status === 413, "A3 流中超限（chunked 无 Content-Length）→ 413");
    const st = await c.callTool({
      name: "run_command",
      arguments: {
        command:
          "printf 'content:'; cat /tmp/ssh-mcp-midstream.bin; " +
          "printf '\\ntemps:'; find /tmp -maxdepth 1 -name '.ssh-mcp-midstream.bin.ssh-mcp-*' -print",
      },
    });
    const stText = String(st.content?.[0]?.text);
    check(stText.includes("content:ORIGINAL_CONTENT") && !stText.includes("/tmp/.ssh-mcp-midstream.bin.ssh-mcp-"), "A3 中断上传保留原文件且清理临时文件");
    await c.callTool({ name: "run_command", arguments: { command: "rm -f /tmp/ssh-mcp-midstream.bin" } });
    await c.close();
  } catch (e) {
    failures++;
    console.log(`!! A3-流中异常: ${e.message}`);
  } finally {
    stop(child);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 尽力清理 */ }
}

// ============ 完整 MCP 流程（需要 config.json 默认服务器可达） ============
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-full-"));
  const auditDir = path.join(tmp, "audit");
  // 复用仓库 config.json（真实目标服务器）并临时开审计
  const fullCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  fullCfg.servers = fullCfg.servers.map((s) => ({ ...s, allowedFileRoots: ["/tmp"] }));
  fullCfg.servers.push({
    ...fullCfg.servers[0],
    id: "bad-fingerprint",
    name: "错误指纹测试目标",
    hostFingerprint: `SHA256:${"A".repeat(43)}`,
  });
  fullCfg.defaults = { ...(fullCfg.defaults ?? {}), maxConcurrentSsh: 1 };
  fullCfg.audit = { enabled: true, dir: auditDir };
  // 本块防爆破断言依赖 127.0.0.1 失败计数：清空仓库配置里的豁免网段，避免随生产示例配置漂移而恒红
  fullCfg.auth = { ...(fullCfg.auth ?? {}), banAllowlist: [] };
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(fullCfg));

  const base = "http://127.0.0.1:18080";
  const child = startServer(18080, { env: { SSH_MCP_TOKEN: "e2e-full-flow-token", SSH_MCP_CONFIG: cfgPath } });
  try {
    await waitReady(base, child);
    const client = await mcpConnect(base, "e2e-full-flow-token");
    const tools = await client.listTools();
    check(tools.tools.length === 6, `完整流程 list_tools 6 个（${tools.tools.map((t) => t.name).join("/")}）`);

    const echo = await client.callTool({ name: "run_command", arguments: { command: "echo E2E_OK_$(hostname)" } });
    check(!echo.isError && String(echo.content?.[0]?.text).includes("E2E_OK_"), "完整流程 run_command 执行成功");

    const badFingerprint = await client.callTool({
      name: "run_command",
      arguments: { command: "echo SHOULD_NOT_RUN", server: "bad-fingerprint" },
    });
    const afterBadFingerprint = await client.callTool({ name: "run_command", arguments: { command: "echo STILL_ALIVE" } });
    check(badFingerprint.isError && !afterBadFingerprint.isError && String(afterBadFingerprint.content?.[0]?.text).includes("STILL_ALIVE"), "A1 错误 SSH 指纹拒绝连接且网关保持运行");

    const parallelClient = await mcpConnect(base, "e2e-full-flow-token");
    const parallelStart = Date.now();
    await Promise.all([
      client.callTool({ name: "run_command", arguments: { command: "sleep 1; echo SLOT_A" } }),
      parallelClient.callTool({ name: "run_command", arguments: { command: "sleep 1; echo SLOT_B" } }),
    ]);
    const parallelElapsed = Date.now() - parallelStart;
    check(parallelElapsed >= 1700, `A1 SSH 并发上限排队生效（${parallelElapsed}ms）`);
    await parallelClient.close();

    const blocked = await client.callTool({ name: "run_command", arguments: { command: "shutdown -h now" } });
    check(blocked.isError && String(blocked.content?.[0]?.text).includes("安全策略拦截"), "完整流程 危险命令被拦截");
    const ddBlocked = await client.callTool({ name: "run_command", arguments: { command: "dd if=/dev/zero of=/dev/sda bs=1M" } });
    check(ddBlocked.isError && String(ddBlocked.content?.[0]?.text).includes("安全策略拦截"), "A4 dd of=/dev/sd* 被新黑名单拦截");
    const chmodBlocked = await client.callTool({ name: "run_command", arguments: { command: "chmod -R 777 /" } });
    check(chmodBlocked.isError && String(chmodBlocked.content?.[0]?.text).includes("安全策略拦截"), "A4 chmod -R 777 / 被新黑名单拦截");

    // A2：cwd 参数（成功 + 失败）
    const cwdOk = await client.callTool({ name: "run_command", arguments: { command: "pwd", cwd: "/etc" } });
    check(!cwdOk.isError && String(cwdOk.content?.[0]?.text).includes("\n/etc\n"), "A2 cwd=/etc 时 pwd 输出 /etc");
    const cwdBad = await client.callTool({ name: "run_command", arguments: { command: "pwd", cwd: "/no/such/dir-xyz" } });
    check(!cwdBad.isError && cwdBad.content?.[0]?.text.includes("exit_code: 1"), "A2 无效 cwd → shell 报错 exit_code 1");

    // A1：后台任务全生命周期
    const bg = await client.callTool({
      name: "run_command",
      arguments: { command: "sleep 4 && echo BG_DONE_MARKER", background: true },
    });
    const jobId = (String(bg.content?.[0]?.text).match(/job_id: ([0-9a-f]{12})/) || [])[1];
    check(!!jobId, `A1 后台启动立即返回 job_id（${jobId ?? "无"}）`);
    const mid = await client.callTool({ name: "check_job", arguments: { job_id: jobId } });
    const midText = String(mid.content?.[0]?.text);
    check(/state: (running|done)/.test(midText), `A1 check_job 可查询（${/state: \w+/.exec(midText)?.[0]}）`);
    await sleep(4500);
    const fin = await client.callTool({ name: "check_job", arguments: { job_id: jobId } });
    const finText = String(fin.content?.[0]?.text);
    check(finText.includes("state: done") && finText.includes("exit_code: 0") && finText.includes("BG_DONE_MARKER"), "A1 完成后 done + exit_code 0 + 输出可见");

    const bgLong = await client.callTool({
      name: "run_command",
      arguments: { command: "sleep 300 && echo NEVER", background: true },
    });
    const longId = (String(bgLong.content?.[0]?.text).match(/job_id: ([0-9a-f]{12})/) || [])[1];
    const killed = await client.callTool({ name: "kill_job", arguments: { job_id: longId } });
    check(!killed.isError, "A1 kill_job 终止运行中任务");
    const killedState = await client.callTool({ name: "check_job", arguments: { job_id: longId } });
    check(String(killedState.content?.[0]?.text).includes("state: killed"), "A1 被杀任务 state=killed");

    // A5：>64KB 输出头尾智能截断（断言首尾标记同时存在——防"只保头丢尾"回归）
    const big200k = await client.callTool({
      name: "run_command",
      arguments: { command: "echo HEAD_MARKER_AAA; head -c 200000 /dev/zero | tr '\\0' 'M'; echo TAIL_MARKER_ZZZ" },
    });
    const bigText = String(big200k.content?.[0]?.text);
    check(
      big200k.content?.[0]?.text && bigText.includes("HEAD_MARKER_AAA") && bigText.includes("TAIL_MARKER_ZZZ") && bigText.includes("中间省略") && bigText.length < 200000,
      "A5 >64KB 输出保留头尾并带省略标记"
    );
    const badJob = await client.callTool({ name: "check_job", arguments: { job_id: "zz-not-hex" } });
    check(badJob.isError && String(badJob.content?.[0]?.text).includes("非法的 job_id"), "A1 非法 job_id 被拒绝");

    const relativeUp = await client.callTool({
      name: "upload_file",
      arguments: { remote_path: "tmp/not-absolute", content_base64: Buffer.from("x").toString("base64") },
    });
    check(relativeUp.isError && String(relativeUp.content?.[0]?.text).includes("绝对路径"), "A4 MCP 文件工具拒绝相对路径");

    await client.callTool({ name: "run_command", arguments: { command: "ln -sfn /etc /tmp/ssh-mcp-escape-link" } });
    const symlinkEscape = await client.callTool({
      name: "download_file",
      arguments: { remote_path: "/tmp/ssh-mcp-escape-link/passwd" },
    });
    check(symlinkEscape.isError && String(symlinkEscape.content?.[0]?.text).includes("允许范围"), "A4 allowedFileRoots 拒绝符号链接逃逸");
    await client.callTool({ name: "run_command", arguments: { command: "rm -f /tmp/ssh-mcp-escape-link" } });

    const streamDenied = await fetch(`${base}/upload?path=${encodeURIComponent("/etc/ssh-mcp-denied.bin")}`, {
      method: "POST",
      headers: { authorization: "Bearer e2e-full-flow-token" },
      body: "x",
    });
    check(streamDenied.status === 400, "A4 /upload 强制 allowedFileRoots");

    // A4：MCP base64 上传 200KB（JSON 请求体约 273KB > 旧 express 默认 100KB 限制）
    const big = Buffer.alloc(200 * 1024, 97);
    const bigUp = await client.callTool({
      name: "upload_file",
      arguments: { remote_path: "/tmp/ssh-mcp-e2e-200k.bin", content_base64: big.toString("base64") },
    });
    check(!bigUp.isError, "A4 MCP 上传 200KB（HTTP body 超 100KB 旧限）成功");
    await client.callTool({ name: "run_command", arguments: { command: "rm -f /tmp/ssh-mcp-e2e-200k.bin" } });

    const content = `e2e audit test ${Date.now()}\n`;
    await client.callTool({
      name: "run_command",
      arguments: { command: "printf OLD > /tmp/ssh-mcp-e2e-test.txt && chmod 640 /tmp/ssh-mcp-e2e-test.txt" },
    });
    const up = await client.callTool({
      name: "upload_file",
      arguments: { remote_path: "/tmp/ssh-mcp-e2e-test.txt", content_base64: Buffer.from(content).toString("base64") },
    });
    check(!up.isError, "完整流程 upload_file 成功");
    const down = await client.callTool({ name: "download_file", arguments: { remote_path: "/tmp/ssh-mcp-e2e-test.txt" } });
    const preservedMode = await client.callTool({ name: "run_command", arguments: { command: "stat -c %a /tmp/ssh-mcp-e2e-test.txt" } });
    check(!down.isError && String(down.content?.[0]?.text).includes(content.trim()) && String(preservedMode.content?.[0]?.text).includes("\n640\n"), "完整流程原子覆盖内容一致且保留原权限");
    await client.callTool({ name: "run_command", arguments: { command: "rm -f /tmp/ssh-mcp-e2e-test.txt" } });

    const binary = Buffer.from([0xff, 0xfe, 0xfd]);
    const binaryUp = await client.callTool({
      name: "upload_file",
      arguments: { remote_path: "/tmp/ssh-mcp-e2e-binary.bin", content_base64: binary.toString("base64") },
    });
    const binaryDown = await client.callTool({ name: "download_file", arguments: { remote_path: "/tmp/ssh-mcp-e2e-binary.bin" } });
    const binaryText = String(binaryDown.content?.[0]?.text);
    check(!binaryUp.isError && !binaryDown.isError && binaryText.includes("编码: base64") && binaryText.includes(binary.toString("base64")), "A4 非法 UTF-8 数据按二进制 base64 返回");
    await client.callTool({ name: "run_command", arguments: { command: "rm -f /tmp/ssh-mcp-e2e-binary.bin" } });

    // A1：流式 /upload 8MB 随机数据，md5/bytes 与本地比对；mode=0600
    const payload = crypto.randomBytes(8 * 1024 * 1024);
    const md5local = crypto.createHash("md5").update(payload).digest("hex");
    const streamRes = await fetch(`${base}/upload?path=${encodeURIComponent("/tmp/ssh-mcp-e2e-stream.bin")}&mode=0600`, {
      method: "POST",
      headers: { authorization: `Bearer e2e-full-flow-token` },
      body: payload,
    });
    const streamJson = await streamRes.json();
    check(
      streamRes.status === 200 && streamJson.ok && streamJson.bytes === payload.length && streamJson.md5 === md5local,
      `A1 流式 /upload 8MB 成功且 md5 一致（${streamJson.md5?.slice(0, 8)}…）`
    );
    const modeCheck = await client.callTool({ name: "run_command", arguments: { command: "stat -c %a /tmp/ssh-mcp-e2e-stream.bin" } });
    check(!modeCheck.isError && String(modeCheck.content?.[0]?.text).includes("\n600\n"), "A1 mode=0600 生效");

    // A3：GET /download 流式下载同一文件，字节/头部 md5 与本地一致
    const dlRes = await fetch(`${base}/download?path=${encodeURIComponent("/tmp/ssh-mcp-e2e-stream.bin")}`, {
      headers: { authorization: `Bearer e2e-full-flow-token` },
    });
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    check(
      dlRes.status === 200 &&
        dlBuf.length === payload.length &&
        dlRes.headers.get("x-md5") === md5local &&
        crypto.createHash("sha256").update(dlBuf).digest("hex") === crypto.createHash("sha256").update(payload).digest("hex"),
      "A3 GET /download 8MB 字节一致 + X-Md5 头正确"
    );
    const dlBlk = await fetch(`${base}/download?path=${encodeURIComponent("/root/.ssh/authorized_keys")}`, {
      headers: { authorization: `Bearer e2e-full-flow-token` },
    });
    check(dlBlk.status === 400, "A3 /download 敏感路径 400");
    const dlNoTok = await fetch(`${base}/download?path=${encodeURIComponent("/tmp/x")}`);
    check(dlNoTok.status === 401, "A3 /download 无 token 401");

    // A2：审计含 upload_stream/download_stream 条目与 run_command result 摘要（不含文件内容）
    await sleep(400); // 审计异步落盘
    const auditFile = fs.readdirSync(auditDir).find((f) => f.startsWith("audit-") && f.endsWith(".log"));
    const auditLines = fs.readFileSync(path.join(auditDir, auditFile), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const streamAudit = auditLines.find((e) => e.tool === "upload_stream" && e.args?.bytes === payload.length);
    check(!!streamAudit && streamAudit.ok === true && streamAudit.args?.md5 === md5local && streamAudit.tokenId === "env", "A2 审计 upload_stream 条目（bytes/md5/身份）");
    const dlAudit = auditLines.find((e) => e.tool === "download_stream" && e.args?.bytes === payload.length);
    check(!!dlAudit && dlAudit.ok === true, "A5 审计 download_stream 条目（bytes/md5/身份）");
    const runAudit = auditLines.find((e) => e.tool === "run_command" && e.args?.command?.startsWith("echo E2E_OK"));
    check(!!runAudit && runAudit.result && typeof runAudit.result.text === "string" && runAudit.result.text.length <= 1300, "A5 审计含 run_command result 摘要（≤上限）");
    check(!fs.readFileSync(path.join(auditDir, auditFile), "utf8").includes("content_base64"), "A2 审计不含文件内容");

    // A2：/upload 错误 token → 401，且按「IP+凭据指纹」计入防爆破（默认阈值 10）
    const up401 = async (t) => (await fetch(`${base}/upload?path=${encodeURIComponent("/tmp/x.bin")}`, {
      method: "POST", headers: { authorization: `Bearer ${t}` }, body: "x",
    })).status;
    check((await up401("wrong-upload-token")) === 401, "A2 /upload 错误 token → 401");
    for (let i = 0; i < 8; i++) await up401("wrong-upload-token"); // 同键累计到 10（含首次），未封禁
    await client.callTool({ name: "run_command", arguments: { command: "rm -f /tmp/ssh-mcp-e2e-stream.bin" } });
    await client.close();
    check((await up401("wrong-upload-token")) === 401, "A2 第 10 次失败仍 401（计满当次不跳 429）");
    check((await up401("wrong-upload-token")) === 429, "A2 /upload 401 计入防爆破 → 同键达阈值后 429");

    // A1：网关重启后 job 状态文件在目标机上，仍可查询（封禁态在内存中，重启后自然解除）
    stop(child);
    await sleep(300);
    const child2 = startServer(18080, { env: { SSH_MCP_TOKEN: "e2e-full-flow-token", SSH_MCP_CONFIG: cfgPath } });
    try {
      await waitReady(base, child2);
      const c2 = await mcpConnect(base, "e2e-full-flow-token");
      const afterRestart = await c2.callTool({ name: "check_job", arguments: { job_id: jobId } });
      check(
        String(afterRestart.content?.[0]?.text).includes("state: done"),
        "A1 网关重启后 check_job 仍可查询（目标机状态文件）"
      );
      await c2.close();
    } finally {
      stop(child2);
    }
  } catch (e) {
    failures++;
    console.log(`!! 完整流程异常（需 config.json 默认服务器可达）: ${e.message}`);
  } finally {
    stop(child);
  }
}

// ============ v0.4 新特性：TLS / 代理白名单 / 豁免网段 / 高危确认 / Token 文件（不依赖 SSH 目标） ============
{
  const rawMcpH = (base, token, headers = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token != null ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

  const httpsGet = (port, pathName = "/healthz") =>
    new Promise((resolve, reject) => {
      const req = https.get(
        { host: "127.0.0.1", port, path: pathName, rejectUnauthorized: false, timeout: 5000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
    });

  const waitExit = (child) => new Promise((r) => child.on("exit", (code) => r(code)));

  // 自签证书过不了 fetch 的默认 CA 校验，探活走 https 直连（rejectUnauthorized:false）
  const waitReadyTls = async (port, child) => {
    for (let i = 0; i < 50; i++) {
      if (child.exitCode != null) throw new Error(`server 提前退出（code=${child.exitCode}）`);
      try {
        const r = await httpsGet(port);
        if (r.status === 200) return;
      } catch { /* not yet */ }
      await sleep(200);
    }
    throw new Error("server 启动超时");
  };

  // ---- V1 TLS（A1）----
  {
    const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-tls-"));
    let genOk = true;
    try {
      execFileSync(path.join(__dirname, "scripts", "gen-cert.sh"), ["-o", tlsDir, "-n", "test-gateway"], { stdio: "pipe" });
    } catch {
      genOk = false;
    }
    const cert = path.join(tlsDir, "mcp-cert.pem");
    const key = path.join(tlsDir, "mcp-key.pem");
    check(
      genOk && fs.existsSync(cert) && fs.existsSync(key) && (fs.statSync(key).mode & 0o777) === 0o600,
      "V1 gen-cert.sh 生成证书对（私钥 0600）"
    );

    const child = startServer(18090, {
      env: { SSH_MCP_TOKEN: "tls-token-123", SSH_MCP_TLS_CERT: cert, SSH_MCP_TLS_KEY: key },
    });
    try {
      await waitReadyTls(18090, child);
      const h = await httpsGet(18090);
      check(h.status === 200 && JSON.parse(h.body).ok === true, "V1 TLS 握手成功，/healthz 经 HTTPS 200");
      const httpsPostJson = (port, pathName, headers, body) =>
        new Promise((resolve, reject) => {
          const payload = Buffer.from(body);
          const req = https.request(
            { host: "127.0.0.1", port, path: pathName, method: "POST", rejectUnauthorized: false, timeout: 5000, headers: { ...headers, "content-length": payload.length } },
            (res) => {
              let data = "";
              res.on("data", (c) => (data += c));
              res.on("end", () => resolve({ status: res.statusCode, body: data }));
            }
          );
          req.on("error", reject);
          req.on("timeout", () => req.destroy(new Error("timeout")));
          req.write(payload);
          req.end();
        });
      const m = await httpsPostJson(
        18090,
        "/mcp",
        { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer tls-token-123" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
      );
      check(m.status === 200 && m.body.includes("ssh-mcp-server"), "V1 HTTPS 下 /mcp 鉴权与协议正常");
      const plain = await new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port: 18090, path: "/healthz", timeout: 3000 }, (res) => resolve({ plainOk: true, status: res.statusCode }));
        req.on("error", () => resolve({ plainOk: false }));
        req.on("timeout", () => { req.destroy(); resolve({ plainOk: false }); });
      });
      check(plain.plainOk === false, "V1 明文 HTTP 打 HTTPS 端口被 TLS 层拒绝");
    } catch (e) {
      failures++;
      console.log(`!! V1 TLS 异常: ${e.message}`);
    } finally {
      stop(child);
    }

    // 证书/私钥不成对 → 拒绝启动
    const half = startServer(18091, { env: { SSH_MCP_TOKEN: "t", SSH_MCP_TLS_CERT: cert } });
    const halfCode = await Promise.race([waitExit(half).then((c) => (stop(half), c)), sleep(5000).then(() => null)]);
    check(halfCode === 1, "V1 仅配证书未配私钥 → 拒绝启动");

    // 未配置 TLS → 保持 HTTP
    const plainChild = startServer(18091, { env: { SSH_MCP_TOKEN: "tls-token-123" } });
    try {
      await waitReady("http://127.0.0.1:18091", plainChild);
      const r = await fetch("http://127.0.0.1:18091/healthz");
      check(r.status === 200, "V1 未配置证书保持 HTTP 现状");
    } finally {
      stop(plainChild);
    }
    await sleep(200);
    try { fs.rmSync(tlsDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }

  // ---- V2 代理白名单（A2）+ V3 豁免网段（A3）----
  {
    // 未配置 trustedProxies：伪造 X-Real-IP 不产生独立计数键（同键达阈值封禁 → 429）
    const cfgA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-proxy-")), "config.json");
    fs.writeFileSync(cfgA, JSON.stringify({
      servers: [],
      auth: { tokens: [{ id: "a", token: HEX("a") }], rateLimit: { windowMs: 60_000, maxFails: 5, banMs: 3000 } },
    }));
    const childA = startServer(18092, { env: { SSH_MCP_CONFIG: cfgA } });
    try {
      await waitReady("http://127.0.0.1:18092", childA);
      let all401 = true;
      for (let i = 0; i < 5; i++) {
        if ((await rawMcpH("http://127.0.0.1:18092", "wrong-token", { "x-real-ip": `10.1.1.${i + 1}` })).status !== 401) all401 = false;
      }
      check(all401, "V2 伪造头轮换 5 次均 401");
      const banned = await rawMcpH("http://127.0.0.1:18092", "wrong-token", { "x-real-ip": "10.9.9.9" });
      check(banned.status === 429, "V2 伪造 X-Real-IP 不影响计数（按 socket IP 同键封禁 429）");
    } catch (e) {
      failures++;
      console.log(`!! V2 异常: ${e.message}`);
    } finally {
      stop(childA);
    }
    await sleep(3200); // 等封禁过期，避免端口复用残留

    // trustedProxies 命中对端：采信 X-Real-IP（计数落在 10.9.9.9，而非 127.0.0.1）
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-proxy-"));
    const cfgB = path.join(tmpB, "config.json");
    fs.writeFileSync(cfgB, JSON.stringify({
      servers: [],
      auth: { tokens: [{ id: "a", token: HEX("a") }], trustedProxies: ["127.0.0.1"], rateLimit: { windowMs: 60_000, maxFails: 5, banMs: 3000 } },
    }));
    const childB = startServer(18092, { env: { SSH_MCP_CONFIG: cfgB } });
    try {
      await waitReady("http://127.0.0.1:18092", childB);
      let all401 = true;
      for (let i = 0; i < 5; i++) {
        if ((await rawMcpH("http://127.0.0.1:18092", "wrong-token", { "x-real-ip": "10.9.9.9" })).status !== 401) all401 = false;
      }
      check(all401, "V2 白名单对端 5 次失败 401");
      const noHeader = await rawMcpH("http://127.0.0.1:18092", "wrong-token");
      check(noHeader.status === 401, "V2 计数落在代理头地址（不带头的请求按 127.0.0.1 判定未封禁）");
      const withHeader = await rawMcpH("http://127.0.0.1:18092", "wrong-token", { "x-real-ip": "10.9.9.9" });
      check(withHeader.status === 429, "V2 白名单对端采信代理头（10.9.9.9 键已封禁 429）");
    } catch (e) {
      failures++;
      console.log(`!! V2 白名单异常: ${e.message}`);
    } finally {
      stop(childB);
    }
    await sleep(200);
    try { fs.rmSync(tmpB, { recursive: true, force: true }); } catch { /* 尽力清理 */ }

    // banAllowlist：命中网段永不封禁
    const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-allow-"));
    const cfgC = path.join(tmpC, "config.json");
    fs.writeFileSync(cfgC, JSON.stringify({
      servers: [],
      auth: { tokens: [{ id: "a", token: HEX("a") }], banAllowlist: ["127.0.0.0/8"], rateLimit: { windowMs: 60_000, maxFails: 3, banMs: 3000 } },
    }));
    const childC = startServer(18092, { env: { SSH_MCP_CONFIG: cfgC } });
    try {
      await waitReady("http://127.0.0.1:18092", childC);
      let all401 = true;
      for (let i = 0; i < 10; i++) {
        if ((await rawMcpH("http://127.0.0.1:18092", `wrong-${i}`)).status !== 401) all401 = false;
      }
      check(all401, "V3 豁免网段 10 次失败全部 401、永不 429");
    } catch (e) {
      failures++;
      console.log(`!! V3 异常: ${e.message}`);
    } finally {
      stop(childC);
    }
    await sleep(200);
    try { fs.rmSync(tmpC, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }

  // ---- V4 高危命令二次确认（A4，无 SSH 目标即可验证拒绝路径）----
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-confirm-"));
    const cfgPath = path.join(tmp, "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: [], auth: { tokens: [{ id: "a", token: HEX("a") }] } }));
    const base = "http://127.0.0.1:18093";
    const child = startServer(18093, { env: { SSH_MCP_CONFIG: cfgPath } });
    try {
      await waitReady(base, child);
      const client = await mcpConnect(base, HEX("a"));
      const call = (args) => client.callTool({ name: "run_command", arguments: args });

      const rootHard = await call({ command: 'bash -c "rm -rf /"' });
      check(
        rootHard.isError && String(rootHard.content?.[0]?.text).includes("安全策略拦截"),
        "V4 根分区引号变体命中内置黑名单硬拒（confirm 也无效）"
      );
      const confirmHit = await call({ command: 'rm -rf "/tmp/v4-demo-dir"' });
      check(confirmHit.isError && String(confirmHit.content?.[0]?.text).includes("高危确认清单"), "V4 引号路径递归强删命中确认清单默认拒绝");
      const findHit = await call({ command: "find / -delete" });
      check(findHit.isError && String(findHit.content?.[0]?.text).includes("高危确认清单"), "V4 find / -delete 命中确认清单默认拒绝");
      const hitAgain = await call({ command: 'rm -rf "/tmp/v4-demo-dir"', confirm: true });
      // confirm 通过确认闸门，进入服务器解析（无 servers → 默认服务器错误，而非确认拒绝）
      check(
        hitAgain.isError && !String(hitAgain.content?.[0]?.text).includes("高危确认清单"),
        "V4 confirm=true 通过确认闸门（后续因无目标机报错）"
      );
      const normal = await call({ command: "echo v4-confirm-ok" });
      check(
        normal.isError && !String(normal.content?.[0]?.text).includes("高危确认清单"),
        "V4 未命中命令不受确认流影响"
      );
      const blacklist = await call({ command: "rm -rf /", confirm: true });
      check(
        blacklist.isError && String(blacklist.content?.[0]?.text).includes("安全策略拦截"),
        "V4 黑名单命中即使 confirm=true 也硬拒（黑名单优先）"
      );
      await client.close();
    } catch (e) {
      failures++;
      console.log(`!! V4 异常: ${e.message}`);
    } finally {
      stop(child);
    }
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }

  // ---- V5 SSH_MCP_TOKEN_FILE（A5）----
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-tokenfile-"));
    const tokenFile = path.join(tmp, "token.txt");
    fs.writeFileSync(tokenFile, "file-token-abc123\n");
    fs.chmodSync(tokenFile, 0o600);
    const base = "http://127.0.0.1:18094";
    const child = startServer(18094, { env: { SSH_MCP_TOKEN_FILE: tokenFile } });
    try {
      await waitReady(base, child);
      const ok = await rawMcp(base, "file-token-abc123");
      check(ok.status === 200, "V5 Token 文件读取后正常鉴权（首行、去空白）");
      const bad = await rawMcp(base, "file-token-wrong");
      check(bad.status === 401, "V5 错误 Token 401");
    } catch (e) {
      failures++;
      console.log(`!! V5 异常: ${e.message}`);
    } finally {
      stop(child);
    }

    // 与 SSH_MCP_TOKEN 并存 → 拒绝启动
    const both = startServer(18094, { env: { SSH_MCP_TOKEN: "x", SSH_MCP_TOKEN_FILE: tokenFile } });
    const bothCode = await Promise.race([waitExit(both).then((c) => (stop(both), c)), sleep(5000).then(() => null)]);
    check(bothCode === 1, "V5 与 SSH_MCP_TOKEN 并存 → 拒绝启动");

    // group/other 可写 → 拒绝启动
    fs.chmodSync(tokenFile, 0o664);
    const lax = startServer(18094, { env: { SSH_MCP_TOKEN_FILE: tokenFile } });
    const laxCode = await Promise.race([waitExit(lax).then((c) => (stop(lax), c)), sleep(5000).then(() => null)]);
    check(laxCode === 1, "V5 Token 文件权限过宽 → 拒绝启动");

    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
}

console.log(failures ? `\n${failures} 项失败 ❌` : "\nHTTP 模式测试全部通过 ✅");
process.exit(failures ? 1 : 0);
