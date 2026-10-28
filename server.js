#!/usr/bin/env node
/**
 * server.js —— SSH MCP 服务器（网关）
 *
 * 架构：AI 客户端 --(HTTP+Token, 可经 Nginx 反代)--> 本服务 --(内网 SSH)--> 目标服务器
 * AI 不需要（也不应该）能直连目标服务器的 22 端口。
 *
 * 两种运行模式：
 * 1. stdio（默认，本地调试/本机 AI 客户端）：
 *      node server.js
 * 2. HTTP（服务器部署，供远程 AI 客户端 / Nginx 反代）：
 *      SSH_MCP_TRANSPORT=http SSH_MCP_TOKEN=xxx node server.js
 *    环境变量：
 *      SSH_MCP_TRANSPORT   stdio | http（默认 stdio）
 *      SSH_MCP_HOST        监听地址（默认 127.0.0.1，配合 Nginx 反代）
 *      SSH_MCP_PORT        监听端口（默认 8080）
 *      SSH_MCP_TOKEN       Bearer Token（静态凭据来源之一）
 *      SSH_MCP_TOKEN_FILE  Token 文件路径（首行为 Token；与 SSH_MCP_TOKEN 互斥，文件须去除 group/other 写权限）
 *      SSH_MCP_TLS_CERT    TLS 证书 PEM 路径（与 SSH_MCP_TLS_KEY 成对；配置后以 HTTPS 监听）
 *      SSH_MCP_TLS_KEY     TLS 私钥 PEM 路径
 *      SSH_MCP_TRUST_PROXY 置 1 时信任所有对端的 X-Real-IP / X-Forwarded-For（已弃用，建议 auth.trustedProxies 白名单）
 *      SSH_MCP_CONFIG      配置文件路径（默认同目录 config.json）
 *    config.json 可选 auth 段（与环境变量并存）：
 *      auth.tokens: [{id, token, expiresAt?, disabled?, note?}]   多静态 Token（身份/过期/禁用）
 *      auth.hmac:   {secret, periodHours?, graceBuckets?}          HMAC 派生 Token 自动轮换
 *      auth.rateLimit: {windowMs?, maxFails?, banMs?}              防爆破参数
 *      auth.trustedProxies: ["ip|cidr"]                            信任的反代网段（命中才采信代理头）
 *      auth.banAllowlist:   ["ip|cidr"]                            永不计数/封禁的豁免网段
 *      auth.confirmPatterns: ["正则"]                              高危命令确认清单（缺省用内置清单，显式配置即覆盖）
 *    config.json 可选 tls 段：{cert, key}                          与 SSH_MCP_TLS_* 等效
 *    config.json 可选 audit 段：{enabled: bool, dir?}              审计日志（默认关闭）
 *    HTTP 模式三类凭据来源全缺时拒绝启动；鉴权失败对外一律统一 401。
 *    大文件走流式端点：POST/PUT /upload?path=/abs/path[&server=id][&mode=0600]
 *      （默认上限 defaults.maxStreamUploadBytes=3GiB，恒定内存，返回远端 md5）
 *
 * 注意：stdio 模式下 stdout 被协议占用，日志一律走 stderr。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import express from "express";
import {
  rawConfig,
  servers,
  defaults,
  validateCoreConfig,
  findServer,
  checkBlocked,
  checkBlockedPath,
  checkConfirm,
  runCommandRetry,
  uploadFile,
  uploadFileStream,
  downloadFile,
  downloadFileStream,
  startBackgroundJob,
  checkJob,
  killJob,
} from "./lib.js";
import {
  normalizeAuthConfig,
  createVerifier,
  createServerAcl,
  createRateLimiter,
  createAuditLogger,
  sanitizeAuditArgs,
  bucketAt,
  fingerprint,
  matchIpEntry,
} from "./auth.js";

// ---------- MCP 工具定义 ----------
const TOOLS = [
  {
    name: "list_servers",
    description: "列出可 SSH 连接的服务器列表（来自 config.json）",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_command",
    description:
      "通过 SSH 在指定服务器上执行一条 shell 命令，同步返回 stdout/stderr 和退出码。" +
      "命令必须是单条、无交互的（不支持 vim/top 等交互式程序）。" +
      "长任务（编译/大文件处理等）设 background=true 立即返回 job_id，稍后用 check_job 查询。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令，如 df -h" },
        server: {
          type: "string",
          description: `目标服务器 ID，省略时使用默认（${defaults.serverId ?? "未配置"}）`,
        },
        timeout_ms: {
          type: "number",
          description: `执行超时（毫秒），默认 ${defaults.timeoutMs}，上限 10 分钟（background=true 时不适用）`,
        },
        background: {
          type: "boolean",
          description: "后台执行：立即返回 job_id，命令在目标机 nohup 运行，用 check_job 查询进度与结果",
        },
        cwd: {
          type: "string",
          description: "执行前先切换到该工作目录（可选，目录不存在会报错）",
        },
        confirm: {
          type: "boolean",
          description: "确认执行高危命令：命令命中确认清单（rm -rf 根目录/mkfs/dd 写盘/find -delete 等）时默认拒绝并返回说明，复核确为意图操作后带 confirm=true 重试",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "check_job",
    description:
      "查询后台任务（由 run_command background=true 启动）的状态与输出尾部：" +
      "state 为 running/done/killed，done 时附 exit_code。",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "后台任务 ID（run_command 返回的 job_id）" },
        server: { type: "string", description: "目标服务器 ID（可选，须与启动时一致）" },
        tail_lines: {
          type: "number",
          description: "输出尾部行数，默认 50（1-500）",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "kill_job",
    description: "终止一个仍在运行的后台任务（TERM → 0.5s 后 KILL）。",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "后台任务 ID" },
        server: { type: "string", description: "目标服务器 ID（可选，须与启动时一致）" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "upload_file",
    description:
      "通过 SFTP 上传文件到服务器。content_base64 为文件内容的 base64 编码。" +
      "自动创建父目录，可用 mode 指定八进制权限（如 0644/0755），返回服务端 md5 供校验。" +
      `适合中小文件（上限 ${defaults.maxUploadBytes} 字节）；大文件请用网关流式端点 ` +
      `POST /upload?path=/abs/path（上限 ${defaults.maxStreamUploadBytes} 字节），或服务器侧 wget/scp。`,
    inputSchema: {
      type: "object",
      properties: {
        remote_path: { type: "string", description: "目标绝对路径，如 /opt/app/config.yml" },
        content_base64: { type: "string", description: "文件内容 base64 编码" },
        mode: { type: "string", description: "八进制权限（可选），如 0644、0755" },
        server: { type: "string", description: "目标服务器 ID（可选）" },
      },
      required: ["remote_path", "content_base64"],
    },
  },
  {
    name: "download_file",
    description:
      "从服务器下载文件。文本文件以 utf8 返回，二进制以 base64 返回；响应包含 size/md5/encoding。" +
      `默认上限 ${defaults.maxDownloadBytes} 字节（防撑爆上下文），可用 max_bytes 调整。`,
    inputSchema: {
      type: "object",
      properties: {
        remote_path: { type: "string", description: "服务器上的绝对路径" },
        max_bytes: { type: "number", description: `大小上限（字节），默认 ${defaults.maxDownloadBytes}` },
        server: { type: "string", description: "目标服务器 ID（可选）" },
      },
      required: ["remote_path"],
    },
  },
];

function formatResult(r) {
  const lines = [];
  lines.push(`server: ${r.server}  exit_code: ${r.exitCode}`);
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.truncated)
    lines.push(
      r.omittedBytes > 0
        ? `(输出超过上限，已截断，中间省略 ${r.omittedBytes} 字节——首尾均保留)`
        : `(输出超过上限，已截断)`
    );
  lines.push(`--- stdout ---`);
  lines.push(r.stdout || "(空)");
  if (r.stderr) {
    lines.push(`--- stderr ---`);
    lines.push(r.stderr);
  }
  return lines.join("\n");
}

function createMcpServer(onToolCall, tokenAcl) {
  const mcp = new Server(
    { name: "ssh-mcp-server", version: "0.4.1" },
    { capabilities: { tools: {} } }
  );

  // Token 级服务器访问控制：受限 Token 只能解析到白名单内的服务器，
  // 默认目标取白名单首个；未受限（tokenAcl 为空）走全局默认，行为不变。
  const pick = (requestedId) => {
    if (!tokenAcl) return { s: findServer(requestedId ?? undefined) };
    const r = tokenAcl.resolve(requestedId ?? null);
    if (!r.ok) throw new Error("无权访问指定的服务器");
    if (!r.id) throw new Error("未配置可用的默认服务器");
    return { s: findServer(r.id) };
  };

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  async function handleToolCall(name, args) {
    try {
      if (name === "list_servers") {
        const visible = tokenAcl ? tokenAcl.listServers() : servers;
        // [默认] 标注必须与该 Token 的实际默认目标一致（受限 Token 可能默认到白名单首项）
        const effectiveDefaultId = tokenAcl ? tokenAcl.defaultId : defaults.serverId;
        const text = visible.length
          ? visible
              .map(
                (s) =>
                  `- ${s.id}: ${s.name ?? s.host} (${s.username}@${s.host}:${s.port ?? 22})` +
                  (s.id === effectiveDefaultId ? " [默认]" : "")
              )
              .join("\n")
          : "(config.json 中没有配置任何服务器)";
        return { content: [{ type: "text", text }] };
      }

      if (name === "run_command") {
        const command = String(args.command ?? "").trim();
        if (!command) throw new Error("参数 command 不能为空");

        // 黑名单最高优先级：命中即硬拒，confirm 也无法放行
        const blocked = checkBlocked(command);
        if (blocked) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `命令被安全策略拦截（命中规则: ${blocked}）。如确需执行，请在 config.json 的 blockedCommandPatterns 中调整。`,
              },
            ],
          };
        }

        // 高危命令二次确认：命中确认清单默认拒绝（不建立 SSH 连接），confirm=true 复核后执行
        const confirmHit = checkConfirm(command);
        if (confirmHit && args.confirm !== true) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `命令命中高危确认清单（规则: ${confirmHit}），已拒绝执行：\n  ${command}\n` +
                  `该操作可能造成不可逆影响。确认确需执行后，请携带 confirm: true 重新调用本工具。`,
              },
            ],
          };
        }

        const { s } = pick(args.server != null && String(args.server).trim() !== "" ? String(args.server).trim() : null);
        const cwd = args.cwd != null && String(args.cwd).trim() !== "" ? String(args.cwd).trim() : null;

        if (args.background) {
          const j = await startBackgroundJob(s, command, cwd);
          return {
            content: [
              {
                type: "text",
                text:
                  `后台任务已启动 server: ${s.id}  job_id: ${j.jobId}（pid: ${j.pid}）\n` +
                  `用 check_job 查询进度与结果；长任务结束时输出会保留在目标机任务目录中。`,
              },
            ],
          };
        }

        const timeout = Math.min(
          Number(args.timeout_ms) || defaults.timeoutMs,
          600_000
        );
        const r = await runCommandRetry(s, command, timeout, defaults.maxOutputBytes, cwd);
        return { isError: !r.ok, content: [{ type: "text", text: formatResult(r) }] };
      }

      if (name === "check_job") {
        const jobId = String(args.job_id ?? "").trim();
        if (!jobId) throw new Error("参数 job_id 不能为空");
        const { s } = pick(args.server != null && String(args.server).trim() !== "" ? String(args.server).trim() : null);
        const tailLines = Math.min(Math.max(Math.floor(Number(args.tail_lines) || 50), 1), 500);
        const j = await checkJob(s, jobId, tailLines);
        const lines = [
          `server: ${s.id}  job_id: ${j.jobId}`,
          `state: ${j.state}`,
        ];
        if (j.exitCode != null) lines.push(`exit_code: ${j.exitCode}`);
        lines.push(`--- 输出尾部 ---`);
        lines.push(j.output || "(无输出)");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "kill_job") {
        const jobId = String(args.job_id ?? "").trim();
        if (!jobId) throw new Error("参数 job_id 不能为空");
        const { s } = pick(args.server != null && String(args.server).trim() !== "" ? String(args.server).trim() : null);
        const j = await killJob(s, jobId);
        const text = j.killed
          ? `后台任务已终止 server: ${s.id}  job_id: ${j.jobId}`
          : `终止失败 server: ${s.id}  job_id: ${j.jobId}（${j.error}）`;
        return { isError: !j.killed, content: [{ type: "text", text }] };
      }

      if (name === "upload_file") {
        const remotePath = String(args.remote_path ?? "").trim();
        const contentB64 = String(args.content_base64 ?? "").trim();
        if (!remotePath || !contentB64) throw new Error("remote_path 和 content_base64 均不能为空");
        if (!remotePath.startsWith("/")) throw new Error("remote_path 必须是以 / 开头的绝对路径");

        const blocked = checkBlockedPath(remotePath);
        if (blocked) {
          return {
            isError: true,
            content: [{ type: "text", text: `路径被安全策略拦截（命中规则: ${blocked}）。敏感路径可在 config.json 的 blockedPathPatterns 中调整。` }],
          };
        }

        const { s } = pick(args.server != null && String(args.server).trim() !== "" ? String(args.server).trim() : null);
        const r = await uploadFile(s, remotePath, contentB64, args.mode);
        return {
          content: [{
            type: "text",
            text: `上传成功: ${r.remotePath}（${r.bytes} 字节，服务端 md5: ${r.md5}）`,
          }],
        };
      }

      if (name === "download_file") {
        const remotePath = String(args.remote_path ?? "").trim();
        if (!remotePath) throw new Error("remote_path 不能为空");
        if (!remotePath.startsWith("/")) throw new Error("remote_path 必须是以 / 开头的绝对路径");

        const blocked = checkBlockedPath(remotePath);
        if (blocked) {
          return {
            isError: true,
            content: [{ type: "text", text: `路径被安全策略拦截（命中规则: ${blocked}）` }],
          };
        }

        const { s } = pick(args.server != null && String(args.server).trim() !== "" ? String(args.server).trim() : null);
        const maxBytes = Math.min(Number(args.max_bytes) || defaults.maxDownloadBytes, 5 * 1024 * 1024);
        const r = await downloadFile(s, remotePath, maxBytes);
        return {
          content: [
            {
              type: "text",
              text: `文件: ${r.remotePath}\n大小: ${r.size} 字节\n编码: ${r.encoding}\nmd5: ${r.md5}\n--- content (${r.encoding}) ---\n${r.content}`,
            },
          ],
        };
      }

      throw new Error(`未知工具: ${name}`);
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `错误: ${e.message}` }] };
    }
  }

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const result = await handleToolCall(name, args);
    // 审计钩子：HTTP 层注入（stdio 模式不注入），在结果确定后记录
    if (onToolCall) {
      try {
        onToolCall(name, args ?? {}, result);
      } catch (e) {
        console.error("[ssh-mcp-server] 审计钩子异常:", e?.message);
      }
    }
    return result;
  });

  return mcp;
}

// ---------- 启动模式 ----------
const transportMode = process.env.SSH_MCP_TRANSPORT ?? "stdio";

async function main() {
const coreErrors = validateCoreConfig(rawConfig);
if (coreErrors.length) {
  for (const e of coreErrors) console.error(`[ssh-mcp-server] 配置错误: ${e}`);
  console.error("[ssh-mcp-server] 拒绝启动。");
  process.exit(1);
}
if (transportMode === "stdio") {
  const mcp = createMcpServer();
  await mcp.connect(new StdioServerTransport());
  console.error(
    `[ssh-mcp-server] stdio 模式已启动，服务器数: ${servers.length}，默认: ${defaults.serverId ?? "无"}`
  );
} else if (transportMode === "http") {
  const host = process.env.SSH_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.SSH_MCP_PORT ?? 8080);

  // ---------- 鉴权配置（env Token / 多 Token / HMAC 派生，三者并存） ----------
  const authCfg = normalizeAuthConfig(rawConfig, process.env);
  if (authCfg.errors.length) {
    for (const e of authCfg.errors) console.error(`[ssh-mcp-server] 配置错误: ${e}`);
    console.error("[ssh-mcp-server] 拒绝启动。");
    process.exit(1);
  }
  if (!authCfg.hasAnyCredential) {
    console.error(
      "[ssh-mcp-server] HTTP 模式需要至少一种凭据来源：SSH_MCP_TOKEN 环境变量，" +
        "或 config.json 的 auth.tokens / auth.hmac / auth.hmacUsers。拒绝启动。"
    );
    process.exit(1);
  }
  const verifier = createVerifier(authCfg);
  const limiter = createRateLimiter(authCfg.rateLimit, authCfg.banAllowlist);
  const audit = createAuditLogger(rawConfig.audit, process.cwd());
  const trustProxy = process.env.SSH_MCP_TRUST_PROXY === "1";
  if (trustProxy) {
    console.error(
      "[ssh-mcp-server] 警告: SSH_MCP_TRUST_PROXY=1 已弃用——等同信任所有对端的代理头（可被伪造绕过防爆破）。" +
        "请在 config.json 的 auth.trustedProxies 配置反代网段白名单。"
    );
  }
  const trustedProxies = authCfg.trustedProxies ?? [];
  const serverAcl = createServerAcl(authCfg);

  // ---------- TLS 配置（可选：配置证书后以 HTTPS 监听，未配置保持 HTTP） ----------
  const tlsCertPath = process.env.SSH_MCP_TLS_CERT || rawConfig.tls?.cert || null;
  const tlsKeyPath = process.env.SSH_MCP_TLS_KEY || rawConfig.tls?.key || null;
  if (!!tlsCertPath !== !!tlsKeyPath) {
    console.error("[ssh-mcp-server] 配置错误: TLS 证书与私钥必须成对提供（SSH_MCP_TLS_CERT/KEY 或 config tls.cert/key）。拒绝启动。");
    process.exit(1);
  }
  let tlsOptions = null;
  if (tlsCertPath) {
    try {
      tlsOptions = { cert: fs.readFileSync(tlsCertPath), key: fs.readFileSync(tlsKeyPath) };
    } catch (e) {
      console.error(`[ssh-mcp-server] 配置错误: TLS 证书/私钥无法读取（${e.message}）。拒绝启动。`);
      process.exit(1);
    }
  }

  // 审计 result 摘要（audit.resultChars 可调，默认 1024；0 = 不记录 result）
  const auditResultChars = Number(rawConfig.audit?.resultChars ?? 1024) || 0;
  const auditExcerpt = (text) => {
    const s = String(text ?? "");
    if (!auditResultChars || !s) return null;
    const tailChars = Math.min(256, Math.floor(auditResultChars / 4));
    if (s.length <= auditResultChars + tailChars) return s;
    return (
      s.slice(0, auditResultChars) +
      `…[审计省略 ${s.length - auditResultChars - tailChars} 字符]…` +
      s.slice(-tailChars)
    );
  };

  // 上限配置必须是有限正数——字符串等非法值会让上限校验静默失效（等于无上限）
  for (const key of ["maxUploadBytes", "maxStreamUploadBytes"]) {
    const v = Number(defaults[key]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`[ssh-mcp-server] 配置错误: defaults.${key} 非法（${defaults[key]}），须为正数。拒绝启动。`);
      process.exit(1);
    }
  }
  // 审计 result 摘要长度：非法字符串会静默关闭记录（fail-open），负数会产生畸形摘要
  if (rawConfig.audit?.resultChars != null) {
    const rc = Number(rawConfig.audit.resultChars);
    if (!Number.isFinite(rc) || rc < 0) {
      console.error(`[ssh-mcp-server] 配置错误: audit.resultChars 非法（${rawConfig.audit.resultChars}），须为非负数。拒绝启动。`);
      process.exit(1);
    }
  }

  // 来源 IP 判定：默认取 TCP 对端；仅当对端命中 auth.trustedProxies 白名单（或旧开关
  // SSH_MCP_TRUST_PROXY=1 信任所有对端）时才采信代理头。伪造 X-Real-IP/XFF 无法绕过防爆破。
  const clientIp = (req) => {
    const peer = req.socket.remoteAddress ?? "unknown";
    if (trustProxy || (trustedProxies.length > 0 && matchIpEntry(peer, trustedProxies))) {
      const real = req.get("x-real-ip");
      if (real) return real.trim();
      const xff = req.get("x-forwarded-for");
      if (xff) {
        // 取最右侧（代理链最后一跳写入）的值：XFF 首部由客户端提供、可自行追加伪造，
        // 只有最近一层可信代理追加的地址不可伪造
        const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
    }
    return peer;
  };

  const app = express();
  app.disable("x-powered-by"); // 不暴露框架指纹（X-Powered-By: Express）
  // JSON 解析仅挂 /mcp 路由：① /upload 的原始字节流不会被误解析（application/json 头
  //   会被 body-parser 消费导致 0 字节假成功）；② 位于鉴权之后，未授权请求无法强制网关缓冲大 body。
  // 上限与 MCP 上传上限挂钩（修复 express 默认 100KB 挡住 base64 上传的问题）。
  const jsonParser = express.json({ limit: Math.ceil(defaults.maxUploadBytes * 1.4) + 256 * 1024 });

  // 探活（无鉴权，供 Nginx/监控检查）
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // 防爆破：封禁期内直接 429，不进入鉴权（也避免无效请求消耗 SSH 资源）。
  // 计数键为「来源 IP + 提交凭据指纹」双维：换 Token 或换 IP 单独轮换均无法绕过。
  app.use((req, res, next) => {
    const auth = req.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const ban = limiter.isBanned(clientIp(req), fingerprint(bearer));
    if (ban.banned) {
      res.set("Retry-After", String(ban.retryAfterSec));
      return res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "too many failed attempts, temporarily banned" },
        id: null,
      });
    }
    next();
  });

  // Bearer Token 鉴权（失败对外统一 401，原因只进服务端日志/审计）
  app.use((req, res, next) => {
    const ip = clientIp(req);
    const auth = req.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const v = verifier.verify(bearer);
    if (!v.ok) {
      // 防爆破计数与审计仅针对业务端点（/mcp、/upload、/download）：扫描器打其他路径不应耗尽共享出口 IP 的失败额度
      if (req.path === "/mcp" || req.path === "/upload" || req.path === "/download") {
        const fp = `invalid-${fingerprint(bearer)}`;
        limiter.recordFailure(ip, fingerprint(bearer));
        console.error(`[ssh-mcp-server] 鉴权失败 ip=${ip} token=${fp} 原因=${v.reason}`);
        audit.log({ ip, tokenId: fp, tool: null, args: null, ok: false, error: `auth-failed:${v.reason}` });
      } else {
        console.error(`[ssh-mcp-server] 鉴权失败 ip=${ip} path=${req.path} 原因=${v.reason}`);
      }
      return res
        .status(401)
        .json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
    }
    req.authTokenId = v.tokenId;
    next();
  });

  app.post("/mcp", jsonParser, async (req, res) => {
    try {
      // 无状态模式：每个请求独立的 server + transport。
      // 好处：不依赖会话粘性，Nginx 随便代理/负载均衡。
      const ip = clientIp(req);
      const tokenId = req.authTokenId;
      const mcp = createMcpServer(
        (name, args, result) => {
          const text = result?.content?.[0]?.text ?? null;
          audit.log({
            ip,
            tokenId,
            tool: name,
            args: sanitizeAuditArgs(args),
            ok: !result?.isError,
            error: result?.isError ? (auditExcerpt(text) ?? "error") : null,
            result:
              result && auditResultChars > 0
                ? { isError: !!result.isError, text: auditExcerpt(text) }
                : null,
          });
        },
        serverAcl.forToken(tokenId)
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        onerror: (e) => console.error("[transport onerror]", e?.stack ?? e),
      });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[ssh-mcp-server] 请求处理失败:", e?.stack ?? e);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
      }
    }
  });

  // body-parser 错误（超大/非法 JSON）统一转 JSON-RPC 错误，不返回 HTML
  app.use((err, _req, res, _next) => {
    const status = err?.status ?? err?.statusCode ?? 500;
    if (!res.headersSent) {
      res.status(status).json({
        jsonrpc: "2.0",
        error: { code: status === 413 ? -32003 : -32600, message: status === 413 ? "request too large" : "invalid request" },
        id: null,
      });
    }
  });

  // 大文件流式上传：请求体直接管道到目标机 SFTP，恒定内存（Bearer/防爆破/审计同 /mcp）
  const streamUploadMax = defaults.maxStreamUploadBytes;
  const handleUpload = async (req, res) => {
    const ip = clientIp(req);
    const tokenId = req.authTokenId;
    const remotePath = String(req.query.path ?? "").trim();
    const mode = req.query.mode ? String(req.query.mode) : undefined;
    const auditDone = (ok, args, error) =>
      audit.log({ ip, tokenId, tool: "upload_stream", args, ok, error: error ?? null });

    if (!remotePath || !remotePath.startsWith("/")) {
      auditDone(false, { remote_path: remotePath || null }, "bad-path");
      return res.status(400).json({ error: "path 查询参数必须是以 / 开头的绝对路径" });
    }
    const blocked = checkBlockedPath(remotePath);
    if (blocked) {
      auditDone(false, { remote_path: remotePath }, `blocked-path:${blocked}`);
      return res.status(400).json({ error: `路径被安全策略拦截（命中规则: ${blocked}）` });
    }
    if (mode != null && !/^[0-7]{3,4}$/.test(mode)) {
      auditDone(false, { remote_path: remotePath, mode }, "bad-mode");
      return res.status(400).json({ error: `非法的八进制权限: ${mode}` });
    }
    // Content-Length 预检：超限直接拒绝，不建立 SSH 连接（谎报/缺失由流式计数兜底）
    const cl = Number(req.headers["content-length"] ?? 0);
    if (cl > streamUploadMax) {
      auditDone(false, { remote_path: remotePath, bytes: cl }, "oversize");
      return res
        .status(413)
        .json({ error: `文件过大（${cl} 字节 > 上限 ${streamUploadMax}），可在 config.json 的 defaults.maxStreamUploadBytes 调整` });
    }
    try {
      const tacl = serverAcl.forToken(tokenId);
      const resolved = tacl.resolve(
        req.query.server != null && String(req.query.server).trim() !== "" ? String(req.query.server).trim() : null
      );
      if (!resolved.ok) {
        auditDone(false, { remote_path: remotePath, server: resolved.id ?? null }, `server-acl:${resolved.id ?? "unknown"}`);
        return res.status(403).json({ error: "无权访问指定的服务器" });
      }
      const s = findServer(resolved.id);
      const r = await uploadFileStream(s, remotePath, req, streamUploadMax, mode);
      auditDone(r.ok, { remote_path: remotePath, server: s.id, bytes: r.bytes, md5: r.md5 }, r.ok ? null : r.error);
      if (!r.ok) return res.status(r.code ?? 500).json({ error: r.error });
      res.json({ ok: true, remotePath: r.remotePath, bytes: r.bytes, md5: r.md5 });
    } catch (e) {
      auditDone(false, { remote_path: remotePath }, e.message);
      res.status(400).json({ error: e.message });
    }
  };
  app.post("/upload", handleUpload);
  app.put("/upload", handleUpload);

  // 大文件流式下载：SFTP 读流直透响应（Bearer/防爆破/敏感路径拦截同 /mcp、/upload）
  const handleDownload = async (req, res) => {
    const ip = clientIp(req);
    const tokenId = req.authTokenId;
    const remotePath = String(req.query.path ?? "").trim();
    const auditDone = (ok, args, error) =>
      audit.log({ ip, tokenId, tool: "download_stream", args, ok, error: error ?? null });

    if (!remotePath || !remotePath.startsWith("/")) {
      auditDone(false, { remote_path: remotePath || null }, "bad-path");
      return res.status(400).json({ error: "path 查询参数必须是以 / 开头的绝对路径" });
    }
    const blocked = checkBlockedPath(remotePath);
    if (blocked) {
      auditDone(false, { remote_path: remotePath }, `blocked-path:${blocked}`);
      return res.status(400).json({ error: `路径被安全策略拦截（命中规则: ${blocked}）` });
    }
    try {
      const tacl = serverAcl.forToken(tokenId);
      const resolved = tacl.resolve(
        req.query.server != null && String(req.query.server).trim() !== "" ? String(req.query.server).trim() : null
      );
      if (!resolved.ok) {
        auditDone(false, { remote_path: remotePath, server: resolved.id ?? null }, `server-acl:${resolved.id ?? "unknown"}`);
        return res.status(403).json({ error: "无权访问指定的服务器" });
      }
      const s = findServer(resolved.id);
      const r = await downloadFileStream(s, remotePath, res);
      auditDone(
        r.ok,
        { remote_path: remotePath, server: s.id, bytes: r.bytes, md5: r.md5 },
        r.ok ? null : r.error || (r.aborted ? "客户端中断" : "传输失败")
      );
      if (!r.ok && !res.headersSent) return res.status(500).json({ error: r.error || "传输失败" });
    } catch (e) {
      const notFound = /获取文件信息失败/.test(e.message);
      const serverError = /md5sum 失败/.test(e.message);
      auditDone(false, { remote_path: remotePath }, e.message);
      if (res.headersSent) return res.end(); // 流已开始，只能掐断
      return res.status(notFound ? 404 : serverError ? 500 : 400).json({ error: e.message });
    }
  };
  app.get("/download", handleDownload);

  const server = (tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app)).listen(port, host, () => {
    for (const w of authCfg.warnings) console.error(`[ssh-mcp-server] 警告: ${w}`);
    const weakTokens = authCfg.staticTokens.filter((t) => !/^[0-9a-f]{64,}$/.test(t.token));
    for (const t of weakTokens) {
      console.error(
        `[ssh-mcp-server] 警告: Token "${t.id}" 强度偏低（建议 openssl rand -hex 32 或 node scripts/gen-token.js）`
      );
    }
    if (authCfg.hmac && authCfg.hmac.secret.length < 32) {
      console.error("[ssh-mcp-server] 警告: auth.hmac.secret 强度偏低（派生 Token 的安全性取决于它），建议 ≥32 位强随机串");
    }
    let hmacInfo = "";
    if (authCfg.hmac) {
      const { periodHours, graceBuckets } = authCfg.hmac;
      const cur = bucketAt(periodHours);
      hmacInfo = `，HMAC 轮换: 周期${periodHours}h 宽容±${graceBuckets}桶 当前桶${cur}（${new Date(
        cur * periodHours * 3600 * 1000
      ).toISOString()}）`;
    }
    console.error(
      `[ssh-mcp-server] HTTP 模式已启动: ${tlsOptions ? "https" : "http"}://${host}:${port}/mcp ，` +
        `凭据来源: 静态Token×${authCfg.staticTokens.length}${hmacInfo ? hmacInfo : ""}，` +
        `每人HMAC×${(authCfg.hmacUsers ?? []).length}，` +
        `防爆破: ${authCfg.rateLimit.maxFails}次失败/${authCfg.rateLimit.windowMs}ms 封${authCfg.rateLimit.banMs}ms` +
        `（双维计数，豁免网段×${(authCfg.banAllowlist ?? []).length}），` +
        `审计日志: ${audit.enabled ? audit.dir : "关闭"}，` +
        `流式传输: /upload 上限${Math.round(streamUploadMax / 1024 ** 2)}MB /download 不限` +
        (trustProxy || trustedProxies.length > 0 ? `，信任代理头（${trustProxy ? "所有对端" : `白名单×${trustedProxies.length}`}）` : "") +
        "（Bearer 鉴权已启用）"
    );
  });
  // 大文件上传耗时可能远超 Node 默认 300s 请求超时；头部阶段仍受 headersTimeout 防护
  server.requestTimeout = 0;
} else {
  console.error(
    `[ssh-mcp-server] 未知的 SSH_MCP_TRANSPORT: ${transportMode}（支持 stdio / http）`
  );
  process.exit(1);
}
}

main().catch((e) => {
  console.error("[ssh-mcp-server] 启动失败:", e?.stack ?? e);
  process.exit(1);
});
