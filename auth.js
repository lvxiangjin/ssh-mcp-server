/**
 * auth.js —— HTTP 模式鉴权与防护（与 MCP 协议解耦）：
 *   1. 凭据校验：环境变量静态 Token / config 多静态 Token（id、过期、禁用）/ HMAC 派生 Token（自动轮换）
 *   2. 防爆破：401 失败滑动窗口限速 + 连续失败封禁来源 IP
 *   3. 审计日志：JSONL 按天落盘（默认关闭）
 * 被 server.js 与 scripts/derive-token.js 共享，保证两端派生算法一致。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------- HMAC 派生 Token ----------
/** 时间桶号：bucket = floor(unix秒 / (periodHours*3600)) */
export function bucketAt(periodHours, atMs = Date.now()) {
  return Math.floor(atMs / 1000 / (periodHours * 3600));
}

/** 由 master secret 推导指定桶的派生 Token：hmac-<bucket>-<hex64> */
export function deriveHmacToken(secret, bucket) {
  const hex = crypto
    .createHmac("sha256", secret)
    .update(String(bucket))
    .digest("hex");
  return `hmac-${bucket}-${hex}`;
}

/** 每人独立格式：hmacu-<id>-<桶>-<hex>（derive-token.js 与网关共用） */
export function deriveUserHmacToken(secret, id, bucket) {
  const hex = crypto
    .createHmac("sha256", secret)
    .update(String(bucket))
    .digest("hex");
  return `hmacu-${id}-${bucket}-${hex}`;
}

const HMAC_TOKEN_RE = /^hmac-(\d+)-([0-9a-f]{64})$/;

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Token 指纹（前 8 位），用于无身份失败场景的日志/审计定位，不泄露原值 */
export function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

// ---------- 鉴权配置归一化 ----------
const DEFAULT_RATE_LIMIT = { windowMs: 60_000, maxFails: 10, banMs: 600_000 };
const DEFAULT_HMAC = { periodHours: 24, graceBuckets: 1 };

// ---------- IP / CIDR 匹配（零依赖，node:net 级语义） ----------
function ipToBigInt(ip) {
  // IPv4（含 IPv4-mapped IPv6 归一化）
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  const v4 = mapped ? mapped[1] : ip;
  const m4 = /^(\d{1,3})(?:\.(\d{1,3})){0,3}$/.exec(v4);
  if (m4) {
    const parts = v4.split(".").map(Number);
    if (parts.length !== 4 || parts.some((x) => x > 255)) return null;
    return { v6: false, value: parts.reduce((a, x) => a * 256n + BigInt(x), 0n) };
  }
  // IPv6
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const expand = (s) => (s === "" ? [] : s.split(":"));
  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v6: true, value: groups.reduce((a, g) => a * 65536n + BigInt(parseInt(g, 16)), 0n) };
}

/** 判定 ip 是否命中 IP/CIDR 列表中任意条目；条目非法返回 false（配置校验阶段已拦截） */
export function matchIpEntry(ip, entries = []) {
  const parsed = ipToBigInt(String(ip ?? ""));
  if (!parsed) return false;
  for (const raw of entries) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    const [base, prefixStr] = entry.split("/");
    const baseParsed = ipToBigInt(base);
    if (!baseParsed) continue;
    if (prefixStr == null) {
      if (baseParsed.v6 === parsed.v6 && baseParsed.value === parsed.value) return true;
      // IPv4-mapped IPv6 对端等价匹配 IPv4 条目
      if (parsed.v6 !== baseParsed.v6) {
        if (parsed.v6 && (parsed.value >> 32n) === 0xffffn && !baseParsed.v6 && (parsed.value & 0xffffffffn) === baseParsed.value) return true;
        if (!parsed.v6 && baseParsed.v6 && (baseParsed.value >> 32n) === 0xffffn && (baseParsed.value & 0xffffffffn) === parsed.value) return true;
      }
      continue;
    }
    const prefix = Number(prefixStr);
    const max = baseParsed.v6 ? 128 : 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) continue;
    if (baseParsed.v6 !== parsed.v6) {
      // IPv4-mapped 与 IPv4 条目按 IPv4 前缀比较
      if (parsed.v6 && !baseParsed.v6 && (parsed.value >> 32n) === 0xffffn) {
        const pv = parsed.value & 0xffffffffn;
        const shift = 32n - BigInt(prefix);
        if ((pv >> shift) === (baseParsed.value >> shift)) return true;
      }
      continue;
    }
    const shift = BigInt(max) - BigInt(prefix);
    if ((parsed.value >> shift) === (baseParsed.value >> shift)) return true;
  }
  return false;
}

function validateIpEntries(list, label, errors) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || !x.trim())) {
    errors.push(`${label} 非法，须为 IP/CIDR 字符串数组`);
    return [];
  }
  for (const raw of list) {
    const [base, prefix] = String(raw).trim().split("/");
    const p = ipToBigInt(base);
    if (!p) {
      errors.push(`${label} 含非法条目：${raw}`);
      continue;
    }
    if (prefix != null) {
      const max = p.v6 ? 128 : 32;
      const n = Number(prefix);
      if (!Number.isInteger(n) || n < 0 || n > max) errors.push(`${label} 含非法前缀：${raw}（/${max} 上限）`);
    }
  }
  return list.map((x) => String(x).trim());
}

/**
 * 归一化鉴权配置。凭据来源三者并存：
 *   env.SSH_MCP_TOKEN 或 env.SSH_MCP_TOKEN_FILE（身份固定 env，互斥）
 *   config.auth.tokens[]: {id, token, expiresAt?, disabled?, note?}
 *   config.auth.hmac: {secret, periodHours?, graceBuckets?}
 */
export function normalizeAuthConfig(config = {}, env = process.env) {
  const warnings = [];
  const errors = [];
  const staticTokens = [];
  const staticTokenIds = new Set();
  const staticTokenValues = new Map();
  if (env.SSH_MCP_TOKEN && env.SSH_MCP_TOKEN_FILE) {
    errors.push("SSH_MCP_TOKEN 与 SSH_MCP_TOKEN_FILE 互斥，请只保留一个");
  } else if (env.SSH_MCP_TOKEN_FILE) {
    const file = String(env.SSH_MCP_TOKEN_FILE);
    let token = null;
    try {
      const st = fs.statSync(file);
      // group/other 可写的凭据文件直接拒绝（0600/0400 类私有权限才接受）
      if (st.mode & 0o022) {
        errors.push(`SSH_MCP_TOKEN_FILE 权限过宽（${(st.mode & 0o777).toString(8)}）：${file}，须去除 group/other 写权限`);
      } else {
        const mode = st.mode & 0o777;
        if (mode !== 0o600 && mode !== 0o400) {
          warnings.push(`SSH_MCP_TOKEN_FILE 建议使用 0600 权限：${file}（当前 ${mode.toString(8)}）`);
        }
        token = fs.readFileSync(file, "utf8").split("\n")[0]?.trim() ?? "";
      }
    } catch (e) {
      errors.push(`SSH_MCP_TOKEN_FILE 无法读取：${file}（${e.message}）`);
    }
    if (token) {
      staticTokens.push({ id: "env", token, expiresAtMs: null, disabled: false });
      staticTokenIds.add("env");
      staticTokenValues.set(token, "env");
    } else if (!errors.some((x) => x.includes("SSH_MCP_TOKEN_FILE"))) {
      errors.push(`SSH_MCP_TOKEN_FILE 内容为空：${file}`);
    }
  } else if (env.SSH_MCP_TOKEN) {
    const envToken = String(env.SSH_MCP_TOKEN);
    staticTokens.push({ id: "env", token: envToken, expiresAtMs: null, disabled: false });
    staticTokenIds.add("env");
    staticTokenValues.set(envToken, "env");
  }
  for (const t of config.auth?.tokens ?? []) {
    if (!t || typeof t.token !== "string" || !t.token || typeof t.id !== "string" || !t.id) {
      errors.push("auth.tokens 条目缺少非空 id 或 token");
      continue;
    }
    if (staticTokenIds.has(t.id)) errors.push(`Token id 重复：${t.id}`);
    else staticTokenIds.add(t.id);
    const existingId = staticTokenValues.get(t.token);
    if (existingId) errors.push(`Token 值重复：${existingId} 与 ${t.id}`);
    else staticTokenValues.set(t.token, t.id);
    // expiresAt 解析失败按"已过期"处理（fail-closed）：绝不能因格式笔误把应吊销的 Token 变成永不过期
    const parsedExp = t.expiresAt ? Date.parse(t.expiresAt) : NaN;
    let expiresAtMs = null;
    if (t.expiresAt) {
      if (Number.isFinite(parsedExp)) expiresAtMs = parsedExp;
      else {
        expiresAtMs = -1;
        warnings.push(`Token "${t.id}" 的 expiresAt 无法解析（${t.expiresAt}），已按已过期处理`);
      }
    }
    staticTokens.push({
      id: t.id,
      token: t.token,
      expiresAtMs,
      disabled: !!t.disabled,
      note: t.note ?? "",
    });
  }

  let hmac = null;
  const h = config.auth?.hmac;
  if (h && typeof h.secret === "string" && h.secret) {
    const periodHours = Number(h.periodHours);
    const graceBuckets = Number(h.graceBuckets);
    if (h.periodHours != null && (!Number.isFinite(periodHours) || periodHours <= 0)) {
      errors.push(`auth.hmac.periodHours 非法（${h.periodHours}），须为正数`);
    }
    if (h.graceBuckets != null && (!Number.isFinite(graceBuckets) || graceBuckets < 0)) {
      errors.push(`auth.hmac.graceBuckets 非法（${h.graceBuckets}），须为非负整数`);
    }
    hmac = {
      secret: h.secret,
      periodHours: Number.isFinite(periodHours) && periodHours > 0 ? periodHours : DEFAULT_HMAC.periodHours,
      graceBuckets: Number.isFinite(graceBuckets) && graceBuckets >= 0 ? graceBuckets : DEFAULT_HMAC.graceBuckets,
    };
  }

  const rl = config.auth?.rateLimit ?? {};
  for (const [k, min] of [["windowMs", 1], ["maxFails", 1], ["banMs", 1]]) {
    const v = Number(rl[k]);
    if (rl[k] != null && (!Number.isFinite(v) || v < min)) {
      errors.push(`auth.rateLimit.${k} 非法（${rl[k]}），须为 ≥${min} 的数`);
    }
  }
  const rateLimit = { ...DEFAULT_RATE_LIMIT, ...rl };
  // 代理白名单与封禁豁免网段（IP/CIDR），空/缺省 = 不信任代理头 / 无豁免
  const trustedProxies = validateIpEntries(config.auth?.trustedProxies, "auth.trustedProxies", errors);
  const banAllowlist = validateIpEntries(config.auth?.banAllowlist, "auth.banAllowlist", errors);

  // Token 级服务器访问控制：auth.tokens[].servers 白名单（缺省字段或空数组 = 不限，向后兼容）
  const allServerIds = (config.servers ?? []).map((s) => s?.id).filter((x) => typeof x === "string" && x);
  const tokenServers = new Map(); // tokenId -> string[]（仅记录受限的 token）
  for (const t of config.auth?.tokens ?? []) {
    if (!t || typeof t.id !== "string" || !t.id || t.servers == null) continue;
    if (!Array.isArray(t.servers) || t.servers.some((s) => typeof s !== "string" || !s)) {
      errors.push(`auth.tokens["${t.id}"].servers 非法，须为服务器 id 字符串数组`);
      continue;
    }
    if (t.servers.length === 0) continue; // 空数组 = 不限（与 spec 一致）
    for (const sid of t.servers) {
      if (!allServerIds.includes(sid)) {
        errors.push(`auth.tokens["${t.id}"].servers 引用未定义的服务器 id：${sid}`);
      }
    }
    tokenServers.set(t.id, t.servers);
  }

  // 每人独立 HMAC：auth.hmacUsers[]（各自 secret + 各自 servers 白名单）
  const hmacUsers = [];
  const hmacUserSeen = new Set();
  for (const u of config.auth?.hmacUsers ?? []) {
    if (!u || typeof u.id !== "string" || !/^[a-z0-9_-]+$/.test(u.id)) {
      errors.push(`auth.hmacUsers 条目 id 非法（${u?.id ?? "缺失"}），须为小写字母/数字/_/- 组合`);
      continue;
    }
    if (hmacUserSeen.has(u.id)) {
      errors.push(`auth.hmacUsers 条目 id 重复：${u.id}`);
      continue;
    }
    hmacUserSeen.add(u.id);
    if (typeof u.secret !== "string" || !u.secret) {
      errors.push(`auth.hmacUsers["${u.id}"] 缺少 secret`);
      continue;
    }
    if (u.secret.length < 32) {
      warnings.push(`auth.hmacUsers["${u.id}"] 的 secret 强度偏低（<32 字符）`);
    }
    const periodHours = Number(u.periodHours);
    const graceBuckets = Number(u.graceBuckets);
    if (u.periodHours != null && (!Number.isFinite(periodHours) || periodHours <= 0)) {
      errors.push(`auth.hmacUsers["${u.id}"].periodHours 非法（${u.periodHours}），须为正数`);
    }
    if (u.graceBuckets != null && (!Number.isFinite(graceBuckets) || graceBuckets < 0)) {
      errors.push(`auth.hmacUsers["${u.id}"].graceBuckets 非法（${u.graceBuckets}），须为非负整数`);
    }
    if (u.servers != null && (!Array.isArray(u.servers) || u.servers.some((s) => typeof s !== "string" || !s))) {
      errors.push(`auth.hmacUsers["${u.id}"].servers 非法，须为服务器 id 字符串数组`);
      continue;
    }
    if (u.servers != null) {
      for (const sid of u.servers) {
        if (!allServerIds.includes(sid)) {
          errors.push(`auth.hmacUsers["${u.id}"].servers 引用未定义的服务器 id：${sid}`);
        }
      }
    }
    const servers = Array.isArray(u.servers) && u.servers.length > 0 ? u.servers : null; // 空数组 = 不限（与 tokens 语义一致）
    hmacUsers.push({
      id: u.id,
      secret: u.secret,
      servers,
      periodHours: Number.isFinite(periodHours) && periodHours > 0 ? periodHours : 24,
      graceBuckets: Number.isFinite(graceBuckets) && graceBuckets >= 0 ? graceBuckets : 1,
    });
    if (servers) tokenServers.set(`hmacu-${u.id}`, servers); // 接入既有 servers 白名单强制
  }
  // 键空间隔离：静态 Token id 不得以 hmacu- 开头（与 hmacUsers 的 tokenServers 键冲突）
  for (const t of staticTokens) {
    if (t.id.startsWith("hmacu-")) {
      errors.push(`Token id 非法：${t.id}（保留前缀 hmacu-，请改名）`);
    }
    if (hmac && t.id === "hmac") {
      errors.push('Token id 非法：hmac（启用 auth.hmac 时为保留身份）');
    }
  }

  return {
    staticTokens,
    hmac,
    hmacUsers,
    rateLimit,
    trustedProxies,
    banAllowlist,
    hasAnyCredential: staticTokens.length > 0 || !!hmac || hmacUsers.length > 0,
    allServers: config.servers ?? [],
    // 与 lib.js 的 defaults.serverId 展开语义一致：显式配置（含 null）优先于首台
    defaultServerId:
      config.defaults && "serverId" in config.defaults
        ? config.defaults.serverId ?? null
        : config.servers?.[0]?.id ?? null,
    tokenServers,
    warnings,
    errors,
  };
}

// ---------- Token 级服务器访问控制 ----------
/**
 * 为指定 Token 创建服务器解析器。受限 Token（配置了 servers 白名单）只能访问
 * 白名单内的服务器；默认目标优先取全局 defaults.serverId（须在白名单内），
 * 否则取白名单第一项。未受限（env Token / 无 servers 字段）行为不变。
 */
export function createServerAcl(authCfg) {
  return {
    forToken(tokenId) {
      const allowed = (authCfg.tokenServers && authCfg.tokenServers.get(tokenId)) || null;
      // 默认目标与 list_servers 的 [默认] 标注必须一致：
      // 全局默认在白名单内时用它，否则退回白名单首个（受限 Token 的常见情形）
      const defaultId = allowed
        ? authCfg.defaultServerId && allowed.includes(authCfg.defaultServerId)
          ? authCfg.defaultServerId
          : allowed[0]
        : authCfg.defaultServerId;
      return {
        allowed, // null = 不限
        defaultId, // 未显式指定 server 时的目标，与 list_servers 标注一致
        canUse(id) {
          return !allowed || allowed.includes(id);
        },
        resolve(requestedId) {
          const want = requestedId ?? defaultId;
          if (!want) return { ok: false, id: null };
          if (allowed && !allowed.includes(want)) return { ok: false, id: want };
          return { ok: true, id: want };
        },
        listServers() {
          return allowed ? authCfg.allServers.filter((s) => allowed.includes(s.id)) : authCfg.allServers;
        },
      };
    },
  };
}

// ---------- 凭据校验 ----------
/**
 * 校验 Bearer 值。返回 {ok:true, tokenId} 或 {ok:false, reason}。
 * reason 仅供服务端日志/审计（unknown | expired | disabled | hmac-window），
 * 对外一律统一 401，不区分失败原因。
 */
export function createVerifier(authCfg) {
  const hmac = authCfg.hmac;
  const hmacUsers = authCfg.hmacUsers ?? [];
  const HMAC_USER_RE = /^hmacu-([a-z0-9_-]+)-(\d+)-([0-9a-f]{64})$/;
  return {
    verify(bearer, nowMs = Date.now()) {
      const value = String(bearer ?? "");
      if (!value) return { ok: false, reason: "unknown" };

      // 每人 HMAC 派生 Token：hmacu-<id>-<桶>-<hex>（个人 secret 独立校验）
      const mu = HMAC_USER_RE.exec(value);
      if (mu) {
        const u = hmacUsers.find((x) => x.id === mu[1]);
        if (!u) return { ok: false, reason: "unknown" };
        const bucket = Number(mu[2]);
        const cur = bucketAt(u.periodHours, nowMs);
        if (bucket < cur - u.graceBuckets || bucket > cur + u.graceBuckets) {
          return { ok: false, reason: "hmac-window" };
        }
        const expect = crypto.createHmac("sha256", u.secret).update(String(bucket)).digest("hex");
        if (timingSafeEq(mu[3], expect)) return { ok: true, tokenId: `hmacu-${u.id}` };
        return { ok: false, reason: "unknown" };
      }

      // 全局 HMAC 派生 Token
      if (hmac) {
        const m = HMAC_TOKEN_RE.exec(value);
        if (m) {
          const bucket = Number(m[1]);
          const cur = bucketAt(hmac.periodHours, nowMs);
          if (bucket < cur - hmac.graceBuckets || bucket > cur + hmac.graceBuckets) {
            return { ok: false, reason: "hmac-window" };
          }
          const expect = crypto.createHmac("sha256", hmac.secret).update(String(bucket)).digest("hex");
          if (timingSafeEq(m[2], expect)) return { ok: true, tokenId: "hmac" };
          return { ok: false, reason: "unknown" };
        }
      }

      // 静态 Token（env + config），命中但失效时保留原因用于内部日志
      let specialReason = null;
      for (const t of authCfg.staticTokens) {
        if (!timingSafeEq(value, t.token)) continue;
        if (t.disabled) { specialReason = specialReason ?? "disabled"; continue; }
        if (t.expiresAtMs != null && nowMs >= t.expiresAtMs) { specialReason = specialReason ?? "expired"; continue; }
        return { ok: true, tokenId: t.id };
      }
      return { ok: false, reason: specialReason ?? "unknown" };
    },
  };
}

// ---------- 防爆破 v2：双维限速 + 封禁（进程内存，重启即清零） ----------
/**
 * 计数键为「判定来源 IP + 主体指纹」二元组：换 Token 或换 IP 单独轮换都无法绕过。
 * 同键失败达到 maxFails 封禁该键；同一 IP 跨键累计失败达到 maxFails*IP_FAIL_MULT
 * 升级封禁整个 IP（防海量指纹分散试探）。封禁期内请求不计数、不延长封禁。
 * allowlist: 判定 IP 命中豁免网段时永不计数、永不封禁（防管理网段自我锁死）。
 */
const IP_FAIL_MULT = 3;

export function createRateLimiter(cfg = DEFAULT_RATE_LIMIT, allowlist = []) {
  const state = new Map(); // "ip\x1ffp" -> {fails: number[], banUntil: number}（键级）
  const ipState = new Map(); // ip -> {fails: number[], banUntil: number}（跨键聚合，独立记账）
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const m of [state, ipState]) {
      for (const [k, s] of m) {
        if (s.banUntil && s.banUntil <= now) s.banUntil = 0;
        s.fails = s.fails.filter((t) => now - t < cfg.windowMs);
        if (!s.banUntil && s.fails.length === 0) m.delete(k);
      }
    }
  }, Math.max(cfg.windowMs, 30_000));
  sweep.unref?.();

  const key = (ip, fp) => `${ip}\x1f${fp ?? ""}`;
  const exempt = (ip) => allowlist.length > 0 && matchIpEntry(ip, allowlist);

  return {
    isBanned(ip, fp = "") {
      if (exempt(ip)) return { banned: false };
      const now = Date.now();
      const g = ipState.get(ip);
      if (g?.banUntil && g.banUntil > now) return { banned: true, retryAfterSec: Math.ceil((g.banUntil - now) / 1000) };
      const s = state.get(key(ip, fp));
      if (s?.banUntil && s.banUntil > now) return { banned: true, retryAfterSec: Math.ceil((s.banUntil - now) / 1000) };
      return { banned: false };
    },
    recordFailure(ip, fp = "") {
      if (exempt(ip)) return;
      const now = Date.now();
      // 键级：同 IP + 同凭据指纹达 maxFails → 封该键
      const k = key(ip, fp);
      const s = state.get(k) ?? { fails: [], banUntil: 0 };
      s.fails = s.fails.filter((t) => now - t < cfg.windowMs);
      s.fails.push(now);
      if (s.fails.length >= cfg.maxFails) {
        s.banUntil = now + cfg.banMs;
        s.fails = [];
      }
      state.set(k, s);
      // IP 级聚合：跨全部键的累计失败达 maxFails×IP_FAIL_MULT → 封整个 IP（防海量指纹分散试探）
      const g = ipState.get(ip) ?? { fails: [], banUntil: 0 };
      g.fails = g.fails.filter((t) => now - t < cfg.windowMs);
      g.fails.push(now);
      if (g.fails.length >= cfg.maxFails * IP_FAIL_MULT) {
        g.banUntil = now + cfg.banMs;
        g.fails = [];
      }
      ipState.set(ip, g);
    },
  };
}

// ---------- 审计日志（JSONL 按天，默认关闭） ----------
/** 审计入参白名单：记全文，但绝不记 content_base64 与下载内容 */
export function sanitizeAuditArgs(args = {}) {
  const keep = {};
  for (const k of ["command", "remote_path", "server", "mode", "timeout_ms", "max_bytes", "background", "cwd", "job_id", "tail_lines", "confirm"]) {
    if (args?.[k] != null) keep[k] = args[k];
  }
  return keep;
}

export function createAuditLogger(cfg = {}, baseDir = process.cwd()) {
  if (!cfg.enabled) return { enabled: false, dir: null, log: () => {} };
  const dir = cfg.dir ? path.resolve(cfg.dir) : path.join(baseDir, "logs");
  fs.mkdirSync(dir, { recursive: true });

  let chain = Promise.resolve();
  let lastWarnAt = 0;
  const log = (entry) => {
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    chain = chain
      .then(() => fs.promises.appendFile(path.join(dir, `audit-${day}.log`), line))
      .catch((e) => {
        if (Date.now() - lastWarnAt > 60_000) {
          console.error(`[ssh-mcp-server] 审计日志写入失败: ${e.message}`);
          lastWarnAt = Date.now();
        }
      });
  };
  return { enabled: true, dir, log };
}
