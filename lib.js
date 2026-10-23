/**
 * lib.js —— 核心逻辑：配置、SSH 连接、命令执行、文件传输（SFTP）、安全拦截
 * 与 MCP 协议解耦，可被直接复用（见 test-direct.js / demo-*.js）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";

const { Client: SshClient } = ssh2;

// ---------- 配置加载 ----------
/** 配置文件查找（兼容开发模式与单文件打包模式）：
 *  ① SSH_MCP_CONFIG 环境变量
 *  ② 可执行文件同目录（SEA 单文件部署：config.json 放二进制旁边）
 *  ③ 当前工作目录
 *  ④ 源码目录（开发模式）
 */
function findConfigPath() {
  if (process.env.SSH_MCP_CONFIG) return path.resolve(process.env.SSH_MCP_CONFIG);
  const candidates = [
    path.join(path.dirname(process.execPath), "config.json"),
    path.join(process.cwd(), "config.json"),
    (() => {
      try {
        return path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");
      } catch {
        return path.join(process.cwd(), "config.json");
      }
    })(),
  ];
  for (const c of candidates) {
    // 必须是文件：目录命中会导致 readFileSync 报 EISDIR 而非明确的"配置缺失"
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return candidates[1];
}

const configPath = findConfigPath();

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

export const rawConfig = config;
export const servers = config.servers ?? [];
export const defaults = {
  serverId: servers[0]?.id,
  timeoutMs: 30_000,
  maxOutputBytes: 65_536,
  maxUploadBytes: 5 * 1024 * 1024,        // MCP base64 单文件上传上限
  maxStreamUploadBytes: 3 * 1024 ** 3,    // HTTP /upload 流式上传上限（默认 3GiB，可配）
  maxDownloadBytes: 512 * 1024,           // 单文件下载上限（防撑爆 AI 上下文）
  maxConcurrentSsh: 10,                   // 全局 SSH 连接并发上限
  ...(config.defaults ?? {}),
};

// 内置最低限度黑名单：与 config.blockedCommandPatterns 合并后生效，不依赖部署方
// config 是否同步更新——根分区覆写类规则的引号/包裹绕过在代码层兜死（0.3.x 正则
// 要求 / 后跟空白/结尾/星号，`bash -c "rm -rf /"` 的闭引号导致漏判）。
const BUILTIN_BLOCKED = [
  // rm 递归+强制作用根/通配根：/ 后不允许再出现路径字符（"rm -rf /"、'rm -rf /'、rm -rf /* 均命中；rm -rf /tmp 不受影响）
  String.raw`(?<![\w-])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:["'])?/(?![\w./~-])`,
];

const blockedPatterns = [
  ...BUILTIN_BLOCKED,
  ...(config.blockedCommandPatterns ?? []),
].map((p) => new RegExp(p, "i"));
const blockedPathPatterns = (config.blockedPathPatterns ?? []).map(
  (p) => new RegExp(p, "i")
);

// ---------- 高危命令确认清单（二次确认流） ----------
// 命中即默认拒绝、confirm=true 重试才执行；显式配置 auth.confirmPatterns 时完全覆盖默认清单。
// 与黑名单互补：黑名单命中的命令即使 confirm 也拒绝；确认清单挡「危险但可能合法」的操作。
export const DEFAULT_CONFIRM_PATTERNS = [
  // rm 递归+强制作用根/通配根（含引号与 sudo 前缀变体；目录级如 rm -rf /tmp 不入确认清单，由黑名单/用户判断）
  String.raw`(?<![\w-])(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+["']?/(?![\w./~-])`,
  String.raw`(?<![\w-])(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+["'][^"']*["']`, // rm -rf "<路径>"
  String.raw`(?<![\w-])(?:sudo\s+)?chmod\s+(?:-[a-zA-Z]+\s+)*777\s+/(?:\s|$)`,
  String.raw`\bmkfs(?:\.\w+)?\b`,
  String.raw`\bdd\b[^|]*\bof=/dev/(?:sd|hd|nvme|vd)`,
  String.raw`\bdd\b[^|]*\bif=/dev/(?:zero|random)\b[^|]*\bof=`,
  String.raw`(?<![\w-])(?:sudo\s+)?shred\b[^|]*?/dev/(?:sd|hd|nvme|vd)`,
  String.raw`(?<![\w-])(?:sudo\s+)?find\s+/(?![\w./~-])[\s\S]{0,200}(?<![\w-])\x2Ddelete\b`,
  String.raw`(?:>>?|(?<![\w-])tee\s+)\s*(?:"|')?/etc/(?:passwd|shadow|group|sudoers)\b`,
  String.raw`>>?\s*(?:"|')?/etc/ssh/sshd_config\b`,
];

const confirmPatternsCompiled = (() => {
  const explicit = config.auth?.confirmPatterns;
  const list = Array.isArray(explicit) && explicit.length > 0 ? explicit : DEFAULT_CONFIRM_PATTERNS;
  // 非法正则此处跳过（避免模块加载即崩），由 validateCoreConfig 报错拒绝启动
  const compiled = [];
  for (const p of list) {
    try {
      compiled.push(new RegExp(p, "i"));
    } catch {
      /* 校验阶段统一报错 */
    }
  }
  return compiled;
})();

/** 返回命中的确认规则 source；未命中返回 null（不执行任何动作，仅判定） */
export function checkConfirm(command) {
  for (const re of confirmPatternsCompiled) {
    if (re.test(command)) return re.source;
  }
  return null;
}

function resolveTilde(p) {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function normalizeRemotePath(p) {
  const raw = String(p ?? "");
  if (!raw.startsWith("/")) throw new Error("remote_path 必须是以 / 开头的绝对路径");
  if (/[\0\r\n]/.test(raw)) throw new Error("remote_path 不能包含 NUL 或换行字符");
  return path.posix.normalize(raw);
}

export function assertPathAllowed(serverCfg, remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  const roots = serverCfg.allowedFileRoots;
  if (!roots || !roots.length) return normalized;
  const allowed = roots.map((r) => normalizeRemotePath(r));
  if (!allowed.some((r) => r === "/" || normalized === r || normalized.startsWith(r + "/"))) {
    throw new Error(`\u8def\u5f84\u4e0d\u5728\u5141\u8bb8\u8303\u56f4\u5185: ${normalized}`);
  }
  return normalized;
}

export function validateCoreConfig(configValue = rawConfig) {
  const errors = [];
  const configuredServers = configValue.servers ?? [];
  if (!Array.isArray(configuredServers)) return ["servers 须为数组"];

  const ids = new Set();
  for (const [index, s] of configuredServers.entries()) {
    if (!s || typeof s.id !== "string" || !s.id) {
      errors.push(`servers[${index}].id 缺失或非法`);
      continue;
    }
    if (ids.has(s.id)) errors.push(`服务器 id 重复: ${s.id}`);
    ids.add(s.id);
    for (const key of ["host", "username", "privateKeyPath"]) {
      if (typeof s[key] !== "string" || !s[key]) errors.push(`servers["${s.id}"].${key} 缺失或非法`);
    }
    if (s.hostFingerprint != null && !/^(SHA256:)?[A-Za-z0-9+/]{43}=?$/.test(String(s.hostFingerprint))) {
      errors.push(`servers["${s.id}"].hostFingerprint 非法，须为 SHA256:base64 格式`);
    }
    if (s.allowedFileRoots != null) {
      if (!Array.isArray(s.allowedFileRoots) || s.allowedFileRoots.some((r) => typeof r !== "string" || !r.startsWith("/") || /[\0\r\n]/.test(r))) {
        errors.push(`servers["${s.id}"].allowedFileRoots 非法，须为绝对路径字符串数组`);
      }
    }
  }

  const defaultId = configValue.defaults && "serverId" in configValue.defaults
    ? configValue.defaults.serverId
    : configuredServers[0]?.id;
  if (defaultId != null && !ids.has(defaultId)) errors.push(`defaults.serverId 引用未定义的服务器 id: ${defaultId}`);

  const effectiveDefaults = { ...defaults, ...(configValue.defaults ?? {}) };
  for (const key of ["timeoutMs", "maxOutputBytes", "maxUploadBytes", "maxStreamUploadBytes", "maxDownloadBytes", "maxConcurrentSsh"]) {
    const value = Number(effectiveDefaults[key]);
    if (!Number.isFinite(value) || value <= 0 || (key === "maxConcurrentSsh" && !Number.isInteger(value))) {
      errors.push(`defaults.${key} 非法（${effectiveDefaults[key]}），须为正${key === "maxConcurrentSsh" ? "整数" : "数"}`);
    }
  }

  if (configValue.auth?.confirmPatterns != null) {
    const cp = configValue.auth.confirmPatterns;
    if (!Array.isArray(cp) || cp.length === 0 || cp.some((p) => typeof p !== "string" || !p)) {
      errors.push("auth.confirmPatterns 非法，须为非空正则字符串数组");
    } else {
      for (const p of cp) {
        try {
          new RegExp(p, "i");
        } catch (e) {
          errors.push(`auth.confirmPatterns 含非法正则（${String(p).slice(0, 40)}…）：${e.message}`);
        }
      }
    }
  }
  return errors;
}

export function findServer(id) {
  const target = id ?? defaults.serverId;
  const s = servers.find((x) => x.id === target);
  if (!s) {
    const available = servers.map((x) => x.id).join(", ") || "(无)";
    throw new Error(`未找到服务器配置 id=${target}，可用: ${available}`);
  }
  return s;
}

// ---------- 安全拦截 ----------
export function checkBlocked(command) {
  for (const re of blockedPatterns) {
    if (re.test(command)) return re.source;
  }
  return null;
}

export function checkBlockedPath(p) {
  let candidate = String(p ?? "");
  try { candidate = normalizeRemotePath(candidate); } catch { /* 参数错误由调用方给出更明确提示 */ }
  for (const re of blockedPathPatterns) {
    if (re.test(candidate)) return re.source;
  }
  return null;
}

// ---------- 基础设施 ----------
const CONNECT_ERROR_RE =
  /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|EPIPE/;

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      return new Promise((resolve) => {
        const enter = () => {
          active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            queue.shift()?.();
          });
        };
        if (active < limit) enter();
        else queue.push(enter);
      });
    },
  };
}

const sshSemaphore = createSemaphore(
  Number.isInteger(Number(defaults.maxConcurrentSsh)) && Number(defaults.maxConcurrentSsh) > 0
    ? Number(defaults.maxConcurrentSsh)
    : 10
);

/** 网络抖动自动重试一次 */
async function withConnRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!CONNECT_ERROR_RE.test(e?.message ?? "")) throw e;
    await new Promise((r) => setTimeout(r, 1200));
    return await fn();
  }
}

async function connectServer(serverCfg) {
  const releaseSlot = await sshSemaphore.acquire();
  return new Promise((resolve, reject) => {
    let privateKey;
    try {
      privateKey = fs.readFileSync(resolveTilde(serverCfg.privateKeyPath));
    } catch (e) {
      releaseSlot();
      return reject(new Error(`读取私钥失败 ${serverCfg.privateKeyPath}: ${e.message}`));
    }
    const conn = new SshClient();
    let settled = false;
    let slotReleased = false;
    const releaseOnce = () => {
      if (slotReleased) return;
      slotReleased = true;
      releaseSlot();
    };
    conn
      .once("ready", () => { settled = true; resolve(conn); })
      .once("close", releaseOnce)
      .on("error", (e) => {
        // ssh2 在握手失败时可能连续抛出多个 error 事件：仅 reject 一次，后续吞掉，防 unhandled error 打挂进程
        if (!settled) {
          settled = true;
          releaseOnce();
          reject(new Error(`SSH 连接错误: ${e.message}`));
        }
      });
    try {
      conn.connect({
        host: serverCfg.host,
        port: serverCfg.port ?? 22,
        username: serverCfg.username,
        privateKey,
        readyTimeout: 15_000,
        keepaliveInterval: 10_000,
        ...(serverCfg.hostFingerprint ? {
          hostVerifier(hkey) {
            // 指纹两侧均去掉 base64 填充符再比较：ssh-keygen -lf 输出不带 '='，Node digest 带
            const fp = crypto.createHash("sha256").update(hkey).digest("base64").replace(/=+$/, "");
            const want = String(serverCfg.hostFingerprint).replace(/^SHA256:/, "").replace(/=+$/, "");
            if (fp !== want) {
              console.error("[ssh-mcp-server] Host fingerprint mismatch");
              return false;
            }
            return true;
          },
        } : undefined),
      });
    } catch (e) {
      releaseOnce();
      reject(new Error(`SSH 连接错误: ${e.message}`));
    }
  });
}

function openSftp(conn) {
  return new Promise((res, rej) =>
    conn.sftp((e, s) => (e ? rej(new Error(`打开 SFTP 通道失败: ${e.message}`)) : res(s)))
  );
}

function execOnConn(conn, command) {
  return new Promise((resolve) => {
    conn.exec(command, (err, stream) => {
      if (err) return resolve({ ok: false, exitCode: null, stdout: "", stderr: "", error: err.message });
      let out = "", er = "";
      stream.on("data", (d) => (out += d));
      stream.stderr.on("data", (d) => (er += d));
      stream.on("close", (code) =>
        resolve({ ok: true, exitCode: code, stdout: out, stderr: er, error: "" })
      );
    });
  });
}

/** shell 单引号安全包裹 */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

async function resolveRemotePath(conn, serverCfg, remotePath) {
  const normalized = assertPathAllowed(serverCfg, remotePath);
  const cmd =
    `R=$(realpath -m -- ${shq(normalized)} 2>/dev/null || readlink -m -- ${shq(normalized)} 2>/dev/null) || ` +
    `{ echo "realpath/readlink -m unavailable" >&2; exit 127; }; printf '%s\n' "$R"`;
  const result = await execOnConn(conn, cmd);
  if (result.exitCode !== 0) throw new Error(`解析远端路径失败: ${result.stderr || result.error || result.stdout}`);
  const resolved = assertPathAllowed(serverCfg, (result.stdout || "").trim().split(/\r?\n/)[0]);
  const blocked = checkBlockedPath(resolved);
  if (blocked) throw new Error(`路径被安全策略拦截（命中规则: ${blocked}）`);
  return resolved;
}

function makeUploadTempPath(remotePath) {
  const dir = path.posix.dirname(remotePath);
  const base = path.posix.basename(remotePath);
  return path.posix.join(dir, `.${base}.ssh-mcp-${crypto.randomBytes(8).toString("hex")}`);
}

async function removeRemoteTemp(conn, tempPath) {
  if (!tempPath) return null;
  const result = await execOnConn(conn, `rm -f -- ${shq(tempPath)}`);
  return result.exitCode === 0 ? null : `远端临时文件清理失败: ${result.stderr || result.error}`;
}

async function commitRemoteTemp(conn, tempPath, remotePath) {
  const result = await execOnConn(conn, `mv -f -- ${shq(tempPath)} ${shq(remotePath)}`);
  if (result.exitCode !== 0) throw new Error(`原子替换失败: ${result.stderr || result.error}`);
}

async function readRemoteMode(conn, remotePath) {
  const result = await execOnConn(
    conn,
    `if [ -e ${shq(remotePath)} ]; then stat -Lc %a -- ${shq(remotePath)}; fi`
  );
  if (result.exitCode !== 0) throw new Error(`读取原文件权限失败: ${result.stderr || result.error}`);
  const value = (result.stdout || "").trim();
  return /^[0-7]{3,4}$/.test(value) ? value : null;
}

// ---------- 命令执行 ----------
export function runCommand(
  serverCfg,
  command,
  timeoutMs = defaults.timeoutMs,
  maxOutputBytes = defaults.maxOutputBytes,
  cwd = null
) {
  // cwd 存在时先切换目录（无状态设计：每次调用显式指定，不做跨调用保持）
  const finalCommand = cwd ? `cd ${shq(cwd)} && ${command}` : command;
  return new Promise((resolve) => {
    const result = {
      server: serverCfg.id,
      command,
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      omittedBytes: 0,
      timedOut: false,
      error: "",
    };

    let conn = null;
    let settled = false;
    const timer = setTimeout(() => {
      result.error = `命令超时（>${timeoutMs}ms），已强制断开连接`;
      result.timedOut = true;
      finish();
    }, timeoutMs + 15_000); // 15s 为连接建立预留时间

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn?.end(); } catch { /* ignore */ }
      resolve(result);
    }

    connectServer(serverCfg)
      .then((c) => {
        conn = c;
        c.exec(finalCommand, (err, stream) => {
          if (err) {
            result.error = `exec 失败: ${err.message}`;
            return finish();
          }
          // 智能截断：超限时保留头部 60% + 尾部 40%（AI 需要同时看到命令开头回显与结尾汇总/报错）
          const headCap = Math.max(256, Math.floor(maxOutputBytes * 0.6));
          const tailCap = Math.max(256, maxOutputBytes - headCap);
          const mk = () => ({ head: [], headSize: 0, tail: Buffer.alloc(0), size: 0 });
          const st = { out: mk(), err: mk() };
          const feed = (s, d) => {
            s.size += d.length;
            if (s.size <= maxOutputBytes) {
              // 未超上限：完整保留，不标截断（避免 60%~100% 区间的虚假截断标记）
              s.head.push(d);
              s.headSize += d.length;
              return;
            }
            result.truncated = true;
            const headRoom = headCap - s.headSize;
            if (headRoom > 0) {
              const headPart = d.subarray(0, headRoom);
              const rest = d.subarray(headRoom);
              s.head.push(headPart);
              s.headSize += headPart.length;
              if (rest.length) s.tail = Buffer.concat([s.tail, rest]).subarray(-tailCap);
            } else {
              s.tail = Buffer.concat([s.tail, d]).subarray(-tailCap);
            }
          };
          const emit = (s) => {
            const head = Buffer.concat(s.head);
            if (!s.tail.length) return head.toString("utf8");
            const omitted = s.size - s.headSize - s.tail.length;
            result.omittedBytes += omitted;
            const marker = Buffer.from(`\n…[中间省略 ${omitted} 字节]…\n`);
            return Buffer.concat([head, marker, s.tail]).toString("utf8");
          };
          stream.on("data", (d) => feed(st.out, d));
          stream.stderr.on("data", (d) => feed(st.err, d));
          stream.on("close", (code) => {
            result.ok = true;
            result.exitCode = code;
            result.stdout = emit(st.out);
            result.stderr = emit(st.err);
            finish();
          });
        });
      })
      .catch((e) => {
        result.error = e.message;
        finish();
      });
  });
}

const CONNECT_ERR_MSG_RE = /SSH 连接错误: .*(ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|EPIPE)/;

/** 带一次自动重试的执行入口（对端刚从空闲唤醒时网络会抖） */
export async function runCommandRetry(serverCfg, command, timeoutMs, maxOutputBytes, cwd) {
  let r = await runCommand(serverCfg, command, timeoutMs, maxOutputBytes, cwd);
  if (!r.ok && !r.timedOut && CONNECT_ERR_MSG_RE.test(r.error)) {
    await new Promise((res) => setTimeout(res, 1200));
    r = await runCommand(serverCfg, command, timeoutMs, maxOutputBytes, cwd);
    if (r.ok) r.note = "(首次连接被拒，重试成功)";
  }
  return r;
}

// ---------- 后台任务（状态文件落在目标机，网关无状态可重启） ----------
const JOBS_DIR = "/tmp/.ssh-mcp-jobs";
const JOB_ID_RE = /^[0-9a-f]{12}$/;

/** 启动后台任务：nohup 落到目标机 /tmp/.ssh-mcp-jobs/<id>/，立即返回 job_id */
export async function startBackgroundJob(serverCfg, command, cwd) {
  return withConnRetry(async () => {
    const conn = await connectServer(serverCfg);
    try {
      const id = crypto.randomBytes(6).toString("hex");
      // 按 SSH 账户隔离：/tmp/.ssh-mcp-jobs/<账户名>/<job_id>——多账户（root 管理员 + aiops 受限）互不可见互不干扰
      const userDir = `${JOBS_DIR}/${serverCfg.username}`;
      const dir = `${userDir}/${id}`;
      const cdPart = cwd ? `cd ${shq(cwd)} || exit 127\n` : "";
      const inner = `${cdPart}${command}\nexit_code=$?\necho "$exit_code" > ${shq(dir + "/code")}\n`;
      // /tmp 竞态防护：根目录拒符号链接、0711（其他用户可穿越+创建、不可列举）；账户子目录 700 且属主须为当前账户
      const launch =
        `if [ -L ${JOBS_DIR} ]; then echo "jobs-dir-symlink"; exit 1; fi; ` +
        `[ -d ${JOBS_DIR} ] || install -d -m 0711 ${JOBS_DIR}; ` +
        `if [ -d ${shq(userDir)} ] && [ ! -O ${shq(userDir)} ]; then echo "jobs-user-dir-owner-invalid"; exit 1; fi; ` +
        `install -d -m 700 ${shq(userDir)}; ` +
        `install -d -m 700 ${shq(dir)}; ` +
        `B=sh; command -v bash >/dev/null 2>&1 && B=bash; ` +
        `nohup "$B" -c ${shq(inner)} > ${shq(dir + "/out.log")} 2>&1 < /dev/null & ` +
        `echo $! > ${shq(dir + "/pid")}; sleep 0.2; cat ${shq(dir + "/pid")}`;
      const r = await execOnConn(conn, launch);
      const pid = (r.stdout || "").trim().split(/\s+/)[0];
      if (r.exitCode !== 0 || !/^\d+$/.test(pid)) {
        throw new Error(`启动后台任务失败: ${r.stderr || r.error || r.stdout}`);
      }
      return { ok: true, jobId: id, pid: Number(pid) };
    } finally {
      try { conn.end(); } catch { /* ignore */ }
    }
  });
}

/** 查询后台任务状态与输出尾部；顺带清理目标机上 >7 天的旧任务目录 */
export async function checkJob(serverCfg, jobId, tailLines = 50) {
  return withConnRetry(async () => {
    const conn = await connectServer(serverCfg);
    try {
      if (!JOB_ID_RE.test(jobId)) throw new Error(`非法的 job_id: ${jobId}`);
      const userDir = `${JOBS_DIR}/${serverCfg.username}`;
      const dir = `${userDir}/${jobId}`;
      const script =
        `if [ -d ${shq(dir)} ]; then ` +
        `if [ -f ${shq(dir + "/killed")} ]; then echo "state: killed"; ` +
        `elif [ -f ${shq(dir + "/code")} ]; then echo "state: done"; echo "exit_code: $(cat ${shq(dir + "/code")})"; ` +
        `elif [ -f ${shq(dir + "/pid")} ] && kill -0 "$(cat ${shq(dir + "/pid")})" 2>/dev/null; then echo "state: running"; ` +
        `else echo "state: unknown"; fi; ` +
        `echo "--- output ---"; tail -n ${tailLines} ${shq(dir + "/out.log")} 2>/dev/null | head -c 65536; ` +
        `else echo "state: unknown"; echo "(job 目录不存在，可能已被清理或从未存在)"; fi; ` +
        `find ${shq(userDir)} -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true`;
      const r = await execOnConn(conn, script);
      if (r.exitCode !== 0) throw new Error(r.stderr || r.error || "查询失败");
      const state = (r.stdout.match(/state: (\w+)/) || [])[1] || "unknown";
      const exitCodeRaw = (r.stdout.match(/exit_code: (-?\d+)/) || [])[1];
      const output = r.stdout.split("--- output ---")[1]?.trim() ?? "";
      return {
        ok: true,
        jobId,
        state,
        exitCode: exitCodeRaw != null ? Number(exitCodeRaw) : null,
        output,
      };
    } finally {
      try { conn.end(); } catch { /* ignore */ }
    }
  });
}

/** 终止后台任务：TERM 包装进程与直接子进程，宽限 0.5s 后 KILL，并标记 killed */
export async function killJob(serverCfg, jobId) {
  return withConnRetry(async () => {
    const conn = await connectServer(serverCfg);
    try {
      if (!JOB_ID_RE.test(jobId)) throw new Error(`非法的 job_id: ${jobId}`);
      const dir = `${JOBS_DIR}/${serverCfg.username}/${jobId}`;
      const script =
        `if [ -f ${shq(dir + "/code")} ] || [ -f ${shq(dir + "/killed")} ]; then echo "finished"; ` +
        `elif [ -f ${shq(dir + "/pid")} ]; then PID=$(cat ${shq(dir + "/pid")}); ` +
        `if [ -d /proc/$PID ] && tr '\\0' ' ' < /proc/$PID/cmdline 2>/dev/null | grep -q ${shq(dir)}; then ` +
        `kill -TERM "$PID" 2>/dev/null; pkill -TERM -P "$PID" 2>/dev/null; sleep 0.5; ` +
        `kill -KILL "$PID" 2>/dev/null; pkill -KILL -P "$PID" 2>/dev/null; ` +
        `echo KILLED > ${shq(dir + "/killed")}; echo "killed: $PID"; ` +
        `elif [ -d /proc/$PID ]; then echo "pid-reused"; ` +
        `else echo "process-gone"; fi; ` +
        `else echo "no pid"; fi`;
      const r = await execOnConn(conn, script);
      const out = (r.stdout || "").trim();
      if (/killed: \d+/.test(out)) return { ok: true, jobId, killed: true };
      const reason = out.includes("finished")
        ? "任务已结束（无需终止）"
        : out.includes("pid-reused")
          ? "进程身份校验失败（PID 疑似被复用），已拒绝终止"
          : out.includes("process-gone")
            ? "任务进程已不存在（视为已终止）"
            : out.includes("no pid")
              ? "无 pid 记录（任务可能不存在或已被清理）"
              : out || "终止失败";
      return { ok: !out.includes("pid-reused"), jobId, killed: /killed: \d+|process-gone/.test(out), error: /killed: \d+/.test(out) ? null : reason };
    } finally {
      try { conn.end(); } catch { /* ignore */ }
    }
  });
}

// ---------- 文件传输（SFTP） ----------
/**
 * 上传文件：content 为 base64。自动创建父目录，可选八进制权限。
 * 返回服务端 md5，供调用方校验完整性。
 */
export function uploadFile(serverCfg, remotePath, contentB64, mode) {
  const requestedPath = assertPathAllowed(serverCfg, remotePath);
  if (mode != null && !/^[0-7]{3,4}$/.test(mode)) {
    throw new Error(`非法的八进制权限: ${mode}`);
  }
  return withConnRetry(async () => {
    const buf = Buffer.from(contentB64, "base64");
    if (buf.length === 0) throw new Error("content_base64 解码后为空");
    if (buf.length > defaults.maxUploadBytes) {
      throw new Error(
        `文件过大（${buf.length} 字节 > 上限 ${defaults.maxUploadBytes}），大文件请用命令行（wget/curl/scp）传输`
      );
    }

    const conn = await connectServer(serverCfg);
    let tempPath = null;
    let committed = false;
    try {
      const targetPath = await resolveRemotePath(conn, serverCfg, requestedPath);
      const dir = path.posix.dirname(targetPath);
      if (dir && dir !== "." && dir !== "/") {
        const mk = await execOnConn(conn, `mkdir -p ${shq(dir)}`);
        if (mk.exitCode !== 0) throw new Error(`创建目录失败 ${dir}: ${mk.stderr || mk.error}`);
      }
      const sftp = await openSftp(conn);
      // 未指定 mode 时：沿用目标文件原权限；新文件默认 0644（避免 SFTP 默认 0666 世界可写）
      const finalMode = mode ?? (await readRemoteMode(conn, targetPath)) ?? "644";
      tempPath = makeUploadTempPath(targetPath);
      await new Promise((res, rej) =>
        sftp.writeFile(tempPath, buf, (e) =>
          e ? rej(new Error(`SFTP 写入失败: ${e.message}`)) : res()
        )
      );
      if (finalMode != null) {
        const cm = await execOnConn(conn, `chmod ${finalMode} ${shq(tempPath)}`);
        if (cm.exitCode !== 0) throw new Error(`chmod 失败: ${cm.stderr}`);
      }
      const md5r = await execOnConn(conn, `md5sum ${shq(tempPath)}`);
      if (md5r.exitCode !== 0) throw new Error(`md5sum 失败: ${md5r.stderr || md5r.error}`);
      await commitRemoteTemp(conn, tempPath, targetPath);
      committed = true;
      return {
        ok: true,
        remotePath: targetPath,
        bytes: buf.length,
        md5: (md5r.stdout || "").split(/\s+/)[0] || "",
      };
    } finally {
      if (tempPath && !committed) {
        try { await removeRemoteTemp(conn, tempPath); } catch { /* 连接异常时尽力清理 */ }
      }
      try { conn.end(); } catch { /* ignore */ }
    }
  });
}

/**
 * 大文件流式上传（HTTP /upload 端点专用）：
 * 把 HTTP 请求体直接管道到远端 SFTP 写入流，恒定内存、不落网关磁盘。
 * 超过 maxBytes 立即中止并删除远端半截文件；客户端中断同样清理。
 * 不做自动重试（流不可重放），由调用方决定是否重传。
 */
export function uploadFileStream(serverCfg, remotePath, req, maxBytes, mode) {
  let requestedPath;
  try {
    requestedPath = assertPathAllowed(serverCfg, remotePath);
  } catch (e) {
    return Promise.resolve({ ok: false, code: 400, error: e.message, bytes: 0 });
  }
  return new Promise((resolve) => {
    // 参数先于一切副作用校验：非法 mode 不产生任何远端操作
    if (mode != null && !/^[0-7]{3,4}$/.test(mode)) {
      return resolve({ ok: false, code: 400, error: `非法的八进制权限: ${mode}`, bytes: 0 });
    }

    let conn = null;
    let ws = null;
    let settled = false;
    let count = 0;
    let wsOpened = false;          // SFTP 写流是否已创建（决定失败时要不要清理远端残片）
    let abortInfo = null;          // { code, reason }：任一中断路径的首个原因
    let targetPath = requestedPath;
    let tempPath = null;
    let committed = false;
    let finalMode = mode ?? null;
    const IDLE_MS = 5 * 60_000;    // 空闲看门狗：数据停滞不该无限占用连接

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      try { req.unpipe(ws); } catch { /* ignore */ }
      try { ws?.destroy(); } catch { /* ignore */ }
      try { req.resume(); } catch { /* ignore */ } // 丢弃残余数据，让连接得以关闭
      try { conn?.end(); } catch { /* ignore */ }
      resolve(r);
    };

    /** 带 10s 兜底超时的远端命令（连接僵死时也不能挂住本函数） */
    const safeExec = (cmd) =>
      Promise.race([
        execOnConn(conn, cmd),
        new Promise((res) => setTimeout(() => res({ ok: false, exitCode: -1, stdout: "", stderr: "", error: "执行超时" }), 10_000)),
      ]);

    const rmPartial = async () => {
      if (!tempPath || committed) return null;
      // destroy 可能抢在 SFTP open 完成之前，稍等后只清理本次唯一临时文件。
      const r = await safeExec(`sleep 0.3; rm -f -- ${shq(tempPath)}`);
      return r.exitCode === 0 ? null : `远端残片清理失败: ${r.stderr || r.error}`;
    };

    /** 统一中断入口：首个原因生效；写流已打开时经 close 事件走统一清理 */
    const doAbort = (code, reason) => {
      if (settled || abortInfo) return;
      abortInfo = { code, reason };
      if (!wsOpened) {
        finish({ ok: false, code, error: reason, bytes: count });
      } else {
        try { ws.destroy(); } catch { /* ignore */ } // 触发 close → 统一清理
      }
    };

    // 客户端断开必须在建连前接管，否则事件丢失会让 Promise 永不 settle
    req.on("error", () => doAbort(400, "客户端中断传输"));
    req.on("aborted", () => doAbort(400, "客户端中断传输"));
    req.on("close", () => { if (!req.readableEnded) doAbort(400, "客户端中断传输"); });

    const idleTimer = setTimeout(() => doAbort(408, `传输停滞超时（>${IDLE_MS / 1000}s 无数据）`), IDLE_MS);

    (async () => {
      try {
        conn = await connectServer(serverCfg);
        conn.on("error", () => doAbort(500, "SSH 连接错误"));
        conn.on("close", () => doAbort(500, "SSH 连接已断开"));
        if (abortInfo) return finish({ ok: false, code: abortInfo.code, error: abortInfo.reason, bytes: count });

        targetPath = await resolveRemotePath(conn, serverCfg, requestedPath);
        const dir = path.posix.dirname(targetPath);
        if (dir && dir !== "." && dir !== "/") {
          const mk = await safeExec(`mkdir -p ${shq(dir)}`);
          if (mk.exitCode !== 0) {
            return finish({ ok: false, code: 500, error: `创建目录失败 ${dir}: ${mk.stderr || mk.error}`, bytes: 0 });
          }
        }
        const sftp = await openSftp(conn);
        sftp.on("error", () => doAbort(500, "SFTP 通道错误"));
        if (abortInfo) return finish({ ok: false, code: abortInfo.code, error: abortInfo.reason, bytes: count });

        // 未指定 mode 时：沿用目标文件原权限；新文件默认 0644（避免 SFTP 默认 0666 世界可写）
        if (finalMode == null) finalMode = (await readRemoteMode(conn, targetPath)) ?? "644";
        tempPath = makeUploadTempPath(targetPath);
        ws = sftp.createWriteStream(tempPath, {
          flags: "w",
          mode: mode != null ? parseInt(mode, 8) : 0o644,
          // 默认 64KB 高水位会让 SFTP 写吞吐只有 ~2MB/s；大块写可到数十 MB/s
          highWaterMark: 4 * 1024 * 1024,
        });
        wsOpened = true;
        ws.on("error", (e) => doAbort(500, `SFTP 写入失败: ${e.message}`));

        ws.on("close", async () => {
          if (abortInfo) {
            const note = await rmPartial();
            finish({ ok: false, code: abortInfo.code, error: note ? `${abortInfo.reason}；${note}` : abortInfo.reason, bytes: count });
          } else if (req.readableEnded) {
            if (finalMode != null) {
              const cm = await safeExec(`chmod ${finalMode} ${shq(tempPath)}`);
              if (cm.exitCode !== 0) return finish({ ok: false, code: 500, error: `chmod 失败: ${cm.stderr}`, bytes: count });
            }
            const md5r = await safeExec(`md5sum ${shq(tempPath)}`);
            if (md5r.exitCode !== 0) {
              return finish({ ok: false, code: 500, error: `md5sum 失败: ${md5r.stderr || md5r.error}`, bytes: count });
            }
            const mv = await safeExec(`mv -f -- ${shq(tempPath)} ${shq(targetPath)}`);
            if (mv.exitCode !== 0) {
              const note = await rmPartial();
              return finish({ ok: false, code: 500, error: `原子替换失败: ${mv.stderr || mv.error}${note ? `；${note}` : ""}`, bytes: count });
            }
            committed = true;
            finish({ ok: true, remotePath: targetPath, bytes: count, md5: (md5r.stdout || "").split(/\s+/)[0] || "" });
          } else {
            finish({ ok: false, code: 500, error: "SFTP 写入流意外关闭", bytes: count });
          }
        });

        // 先 pipe 再补计数监听：data 监听会把流切到 flowing 模式，若先挂监听，
        // pipe 之前到达的块会被监听独吞，远端就会写出 0 字节文件
        req.pipe(ws);
        req.on("data", (chunk) => {
          count += chunk.length;
          idleTimer.refresh();
          if (!abortInfo && count > maxBytes) doAbort(413, `文件过大（已超流式上传上限 ${maxBytes} 字节）`);
        });
      } catch (e) {
        const note = await rmPartial();
        const code = /路径|remote_path/.test(e.message) ? 400 : 500;
        finish({ ok: false, code, error: note ? `${e.message}；${note}` : e.message, bytes: count });
      }
    })();
  });
}

/**
 * 下载文件：文本以 utf8 返回，二进制以 base64 返回（响应带 md5 和 encoding）。
 */
export function downloadFile(serverCfg, remotePath, maxBytes = defaults.maxDownloadBytes) {
  const requestedPath = assertPathAllowed(serverCfg, remotePath);
  return withConnRetry(async () => {
    const conn = await connectServer(serverCfg);
    try {
      const targetPath = await resolveRemotePath(conn, serverCfg, requestedPath);
      const sftp = await openSftp(conn);
      const stat = await new Promise((res, rej) =>
        sftp.stat(targetPath, (e, st) =>
          e ? rej(new Error(`获取文件信息失败: ${e.message}`)) : res(st)
        )
      );
      if (stat.isDirectory()) throw new Error(`${targetPath} 是目录，不是文件`);
      if (stat.size > maxBytes) {
        throw new Error(
          `文件过大（${stat.size} 字节 > 上限 ${maxBytes}），请用 run_command 分段读取（head/tail/split）或调大 max_bytes`
        );
      }
      const buf = await new Promise((res, rej) =>
        sftp.readFile(targetPath, (e, d) =>
          e ? rej(new Error(`SFTP 读取失败: ${e.message}`)) : res(d)
        )
      );
      let text = null;
      if (!buf.includes(0)) {
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* 非法 UTF-8 按二进制返回 */ }
      }
      const binary = text == null;
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      return {
        ok: true,
        remotePath: targetPath,
        size: buf.length,
        encoding: binary ? "base64" : "utf8",
        content: binary ? buf.toString("base64") : text,
        md5,
      };
    } finally {
      try { conn.end(); } catch { /* ignore */ }
    }
  });
}

/**
 * 大文件流式下载（HTTP GET /download 端点专用）：
 * 先 stat + md5sum（响应头先行），再把 SFTP 读流直透 HTTP 响应体，恒定内存。
 * 客户端中断时及时止损断开 SSH。不做断点续传。
 */
export async function downloadFileStream(serverCfg, remotePath, res) {
  const requestedPath = assertPathAllowed(serverCfg, remotePath);
  const conn = await connectServer(serverCfg);
  try {
    const targetPath = await resolveRemotePath(conn, serverCfg, requestedPath);
    const sftp = await openSftp(conn);
    const stat = await new Promise((res2, rej) =>
      sftp.stat(targetPath, (e, st) =>
        e ? rej(new Error(`获取文件信息失败: ${e.message}`)) : res2(st)
      )
    );
    if (stat.isDirectory()) throw new Error(`${targetPath} 是目录，不是文件`);
    const md5r = await execOnConn(conn, `md5sum ${shq(targetPath)}`);
    if (md5r.exitCode !== 0) throw new Error(`md5sum 失败: ${md5r.stderr || md5r.error}`);
    const md5 = (md5r.stdout || "").split(/\s+/)[0] || "";

    res.writeHead(200, {
      "content-length": String(stat.size),
      "x-file-size": String(stat.size),
      "x-md5": md5,
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${path.basename(targetPath).replace(/[^\w.\-]/g, "_")}"`,
    });

    let clientGone = false;
    res.on("close", () => { if (!res.writableFinished) clientGone = true; });

    // 空闲看门狗：SFTP 读停滞不应无限占用 HTTP+SSH 连接
    let sent = 0;
    const IDLE_MS = 5 * 60_000;
    let idleTimer = null;

    await new Promise((resolve, reject) => {
      const rs = sftp.createReadStream(targetPath, { highWaterMark: 4 * 1024 * 1024 });
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        try { rs.destroy(); } catch { /* ignore */ }
        try { res.destroy(); } catch { /* ignore */ }
        reject(e);
      };
      const done = () => { if (!settled) { settled = true; clearTimeout(idleTimer); resolve(); } };
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fail(new Error("传输停滞超时（>5min 无数据）")), IDLE_MS);
      };
      rs.on("error", fail);
      rs.on("data", (d) => { sent += d.length; resetIdleTimer(); });
      res.on("close", done);
      res.on("finish", done);
      resetIdleTimer();
      rs.pipe(res);
    });
    clearTimeout(idleTimer);

    // 以实际发送字节数判定完整性：响应 close 早于 writableFinished 置位时
    //（nginx 无缓冲反代下常见），数据已全部送达也不应误报"客户端中断"
    if (sent < stat.size) return { ok: false, aborted: true, bytes: sent, md5 };
    return { ok: true, aborted: clientGone, bytes: stat.size, md5 };
  } catch (e) {
    if (!res.headersSent) throw e; // 前置阶段失败，交给路由返回 JSON 错误
    try { res.destroy(); } catch { /* ignore */ } // 流已开始，只能掐断
    return { ok: false, aborted: false, bytes: 0, md5: null, error: e.message };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}
