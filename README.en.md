<div align="center">

# ssh-mcp-server

**Give your AI agents a safety-catched key to your servers 🔑**

*Let ZCode / Claude Code / Codex / any MCP client securely run commands, transfer files and manage jobs on your servers —*
*while port 22 never needs to be exposed to the AI (or the internet).*

[English](README.en.md) | [简体中文](README.md)

[![CI](https://github.com/lvxiangjin/ssh-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/lvxiangjin/ssh-mcp-server/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.4.1-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](package.json)
[![protocol](https://img.shields.io/badge/protocol-MCP%20Streamable%20HTTP-orange)](https://modelcontextprotocol.io)
[![deploy](https://img.shields.io/badge/deploy-single%20binary%20·%20zero%20deps-8A2BE2)](#-deployment-http-mode-recommended)

</div>

---

```
┌──────────────┐  HTTPS + Bearer Token   ┌────────────────────┐   SSH(22)          ┌─────────────┐
│  AI client   │ ──────────────────────→ │ Nginx → this gateway│ ─────────────────→ │ N servers   │
│ ZCode/Claude │   (the only opening)    │  (single binary)    │  22 open ONLY to   │ low-priv    │
└──────────────┘                         └────────────────────┘  the gateway       │ accounts    │
                                                                                    └─────────────┘
```

**Why it exists, in three lines:**

- 🚪 **Physically isolated from your servers** — the AI only ever sees the gateway's 443. Server firewalls allow port 22 from the gateway machine only. Compromise the AI's network and you still can't touch the servers.
- 🧰 **6 MCP tools + 2 streaming endpoints** — commands, background jobs, uploads and downloads over a single port. 3 GiB files stream through with constant memory.
- 🔐 **A security model designed around "AI will make mistakes"** — command blacklists, high-risk confirmation, sensitive-path interception, dual-dimension brute-force protection, full audit. See [Security](#-security-why-its-safe-to-let-ai-touch-your-servers).

## 🆚 How it differs

| | Manual SSH / Xshell | Classic bastion hosts<br>(JumpServer etc.) | **ssh-mcp-server** |
|---|---|---|---|
| Designed for | Humans typing | Human ops session auditing | **Autonomous AI agents** |
| AI access | ❌ none | 😩 Web UI / interactive sessions — hard to drive | ✅ Native MCP: configure once, then just talk |
| Deployment weight | — | DB + containers + multiple components | **One binary + one config.json** |
| Server exposure | 22 open to user networks | Protocol gateway, heavy | **22 open only to the gateway; a single 443 on the public side** |
| Dangerous-command blocking | none | Session recording (after the fact) | **Before the fact**: blacklist + high-risk confirmation |
| Permission model | account = full power | 4A central management | Token-level server whitelist × low-privilege OS account, **two independent layers** |
| Credential rotation | manual | static / AD / LDAP | **HMAC tokens rotate daily**, per-person secrets |
| File transfer | manual scp | via bastion storage | **3 GiB streaming**, md5-verified, constant memory |
| Cost | — | enterprise licensing / hardware | open source, free |

> In one sentence: bastion hosts answer "*what did humans do*"; ssh-mcp-server answers "*what is the AI **allowed** to do*". It doesn't replace your bastion — many teams will run it behind one, as the AI-dedicated layer.

## ✨ What you get

**Six MCP tools** (all over one 443 port):

| Tool | What it does |
|---|---|
| `list_servers` | List servers this token may access (non-whitelisted ones are **invisible, not just denied**) |
| `run_command` | Run a shell command, get stdout/stderr/exit code; supports `cwd`, `background` jobs, `confirm` for high-risk commands |
| `check_job` | Background job status / exit code / output tail (state lives on the target host — survives gateway restarts; 7-day auto cleanup) |
| `kill_job` | Kill a background job (PID-reuse safe) |
| `upload_file` | SFTP upload (≤5MB, auto-creates parent dirs, atomic overwrite, returns md5) |
| `download_file` | SFTP download (text/binary auto-detected, md5 attached) |

**Two streaming endpoints** (bypass MCP, no base64 inflation):

- `POST /upload` — GB-scale streaming upload, 3 GiB default limit (configurable), constant memory, remote md5 returned
- `GET /download` — unlimited streaming download, `X-Md5` / `X-File-Size` headers up front for verification

Also built in: command timeouts, output truncation (keep head 60% + tail 40% — protects the AI's context window), SSH concurrency cap, one retry on connection failure.

## 🤖 What it looks like with AI tools

Any MCP client works: **ZCode, Claude Code, Codex, Cursor, Cline…** Configure once, then ops becomes conversation.

**Scenario 1 · Ops copilot** — talk instead of typing:

> "Check disk usage on web1 and web2; for anything over 80%, clean logs older than 7 days under /var/log"

The AI calls `list_servers` → `run_command` per host → summarizes. You never log in.

**Scenario 2 · From code change to deployment, zero context switch:**

> "Bug's fixed, deploy it to the test box and verify"

AI edits code locally → builds → `POST /upload` streams the artifact → `run_command` restarts the service → `check_job` / `curl` verifies → reports back. Every step passes the security pipeline and leaves an audit trail.

**Scenario 3 · Unattended ops duty** — scheduled agents:

Use ZCode scheduled tasks (or cron + your AI client) to run nightly inspections: disk, memory, certificate expiry, service liveness — it only pings you when something's wrong. A whitelist-scoped token means even a hallucinating agent can't step outside its servers.

**Scenario 4 · Team tiering** — one key card per person, per client:

Issue each teammate an independent `hmacUsers` token (**rotates daily**, own secret, own server whitelist), landing on their own low-privilege OS account. The intern and the ops lead see different server lists; losing one card revokes one person, nobody else.

**Wiring it up** — ZCode (`~/.zcode/cli/config.json`, user level, or `.zcode/config.json` per project):

```jsonc
{
  "mcp": {
    "servers": {
      "ssh-gateway": {
        // Option A: gateway on the same machine (stdio)
        "command": "node",
        "args": ["/opt/ssh-mcp-server/server.js"]
        // Option B: remote gateway over HTTP (recommended for production)
        // "type": "streamableHttp",
        // "url": "https://mcp.example.com/mcp",
        // "headers": { "Authorization": "Bearer <your-token>" }
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http ssh-gateway "https://mcp.example.com/mcp" \
  --header "Authorization: Bearer <your-token>"
```

Other MCP clients (Cursor / Cline / Codex …): point them at the **same URL with the same Authorization header**, in whatever config format they use.

## 🔒 Security: why it's safe to let AI touch your servers

Design premise: **never trust any single thing the AI produces.** Every command is treated as untrusted input, passes through layered defenses, and lands on an account that lacks the power to do serious damage anyway.

```
 Internet request
    │
    ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ ① Transport    Nginx 443 as the only opening (or built-in TLS)  │
 │                + optional IP allowlist                          │
 ├────────────────────────────────────────────────────────────────┤
 │ ② Identity     Bearer tokens: multi-static / HMAC daily         │
 │                rotation / per-person secrets                    │
 │                Uniform 401s leak no credential state            │
 ├────────────────────────────────────────────────────────────────┤
 │ ③ Brute force  Dual-dimension counting (IP × credential         │
 │                fingerprint) → bans → 429 + Retry-After          │
 │                trustedProxies defeats spoofed X-Real-IP;        │
 │                banAllowlist keeps admins out of the blast zone  │
 ├────────────────────────────────────────────────────────────────┤
 │ ④ Authorization Token-level server whitelist: out-of-scope      │
 │                targets are invisible; denials leak nothing      │
 ├────────────────────────────────────────────────────────────────┤
 │ ⑤ Commands     Hard blacklist (quote-wrapped variants covered,  │
 │                built-in floor merged with your config)          │
 │                High-risk commands: denied by default, require   │
 │                an explicit confirm flag                         │
 ├────────────────────────────────────────────────────────────────┤
 │ ⑥ Files        Path normalization / symlink real-path           │
 │                resolution / sensitive files blocked both ways / │
 │                allowedFileRoots / atomic overwrite / size caps  │
 ├────────────────────────────────────────────────────────────────┤
 │ ⑦ Execution    Dedicated low-privilege OS account + sudo        │
 │                whitelist (damage floor) · timeouts / output     │
 │                truncation / concurrency cap / host fingerprint  │
 │                pinning against MITM                             │
 ├────────────────────────────────────────────────────────────────┤
 │ ⑧ Audit        Daily JSONL: who, from which IP, on which host,  │
 │                ran what, got what back (result digest)          │
 └────────────────────────────────────────────────────────────────┘
```

### Highlights per layer

**② Identity — credentials that don't sit in configs, rotate themselves, and die alone**

- Three credential sources coexist: multi-static tokens (per-id identity, `expiresAt`, `disabled`, old/new coexistence for rotation), HMAC-derived tokens (both ends store only the master secret; tokens change daily with zero redeploys), and per-person `hmacUsers` secrets (one leak affects exactly one person's whitelist)
- `SSH_MCP_TOKEN_FILE` reads the token from a 0600 file; group/other-writable → **refuses to start**
- The philosophy is **fail-closed**: an unparseable `expiresAt` counts as expired; missing credentials refuse startup; invalid or conflicting config refuses startup — better down than running wrong

**③ Brute force — safe to expose online**

- Failed attempts count per "(source IP × credential fingerprint)" pair: rotating just the IP or just the token defeats nothing; a single IP burning through credentials gets the whole IP banned
- `trustedProxies` (IP/CIDR): `X-Real-IP` / `X-Forwarded-For` are honored only when the TCP peer is on the list (rightmost entry) — **spoofed proxy headers can't launder the rate-limit counter**
- `banAllowlist` keeps management subnets from ever being counted, so attackers can't lock admins out by triggering bans

**⑤ Commands — assume the AI will eventually write `rm -rf /`**

- Blacklist covers `rm -rf /` variants, `mkfs`, `dd` to disks, fork bombs, `shutdown`, `chmod -R 777 /`, `kill -9 -1`, raw device writes… matches are **hard-denied**; even `confirm: true` can't override the blacklist
- A built-in floor blacklist merges with your config (v0.4 fixed the `bash -c "rm -rf /"` quote-wrapping bypass), so protection doesn't depend on operators updating configs
- High-risk confirmation: `rm -rf` variants, `shred`, `find / -delete`, redirects onto critical files — denied by default with an explanation, executed only after the AI re-sends `confirm: true` — a human-paced brake for mistakes, zero exemptions for destruction

**⑥⑦ Files & execution — even if every gate passes, the landing account can't do much**

- Sensitive paths blocked for both reads and writes: `/etc/shadow`, `authorized_keys`, `sshd_config`, `/boot`…
- File tools accept absolute paths only, normalize `..`/duplicate slashes, and resolve symlinks to real paths on the target host before checking `allowedFileRoots`
- Uploads land via temp-file + atomic rename — interrupted transfers never corrupt the original
- `scripts/setup-limited-user.sh` creates a dedicated low-privilege AI account in one shot (sudoers enforces `--no-pager`, blocking pager escape)
- SSH host fingerprint pinning (SHA-256) against MITM
- Command timeouts + output truncation: no `tail -f` wedging the gateway, no giant outputs nuking the AI's context

**⑧ Audit — every action has a paper trail**

With `audit.enabled`, daily JSONL files record: caller identity, source IP, target server, full command, and a result digest (first 1024 + last 256 chars, tunable). File contents and raw token values are never logged, so the audit trail doesn't become a new leak.

### Pre-production checklist

- [x] HTTP mode enforces Bearer auth; uniform 401s leak no credential state
- [x] Dual-dimension rate limiting and bans (429 + Retry-After); spoofed proxy headers can't bypass
- [x] Dangerous-command blacklist + high-risk confirmation (gateway-side; OS-level isolation still relies on low-privilege accounts)
- [x] Timeouts / output truncation / transfer size caps / SSH concurrency cap
- [x] Sensitive paths blocked both ways + symlink real-path resolution + directory whitelist
- [x] Audit log (optional, daily JSONL, full command + result digest)
- [x] `X-Powered-By` stripped — no framework fingerprint for probes
- [ ] Give the AI a **dedicated low-privilege SSH account** with sudo whitelisting (`scripts/setup-limited-user.sh` does it in one shot)
- [ ] Target-host firewalls allow 22 **from the gateway machine only**
- [ ] Public exposure must sit behind Nginx + HTTPS (optionally an IP allowlist; set `SSH_MCP_TRUST_PROXY=1` behind the proxy)
- [ ] Issue per-client identities from `auth.tokens` (revoke individually on leak); prefer per-person `hmacUsers` in production

## 🚀 Quick start (local stdio mode)

```bash
npm install
cp config.example.json config.json
# Edit config.json: point servers[0] at your server (host/username/privateKeyPath —
# config.json is gitignored, your real environment never gets committed)
node test-direct.js     # direct SSH test (no MCP)
node test-mcp.js        # stdio MCP protocol test
node test-http.js       # HTTP gateway test suite (incl. 401 auth checks)
```

> Requires Node.js >= 20 (HTTP mode on node 18 throws `crypto is not defined` with
> MCP SDK 1.30 — watch out on distro-packaged node; the SEA binary bundles its own runtime).

## 📦 Deployment (HTTP mode, recommended)

**Single-binary (SEA)** — a ~120MB executable with the Node runtime baked in; the server needs nothing installed:

```bash
bash scripts/build-linux.sh          # produces dist/ssh-mcp-server-linux
scp dist/ssh-mcp-server-linux config.json user@your-server:/opt/ssh-mcp/
ssh user@your-server
cd /opt/ssh-mcp && chmod +x ssh-mcp-server-linux
SSH_MCP_TRANSPORT=http SSH_MCP_TOKEN=<strong-random-token> ./ssh-mcp-server-linux
```

Config lookup order: `SSH_MCP_CONFIG` env → the executable's directory → cwd. Point systemd's `ExecStart` at the binary and you're done. (Or run from source: `npm install --omit=dev && SSH_MCP_TRANSPORT=http SSH_MCP_TOKEN=... node server.js`.)

**Key environment variables:**

| Variable | Purpose | Default |
|---|---|---|
| `SSH_MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
| `SSH_MCP_HOST` / `SSH_MCP_PORT` | HTTP listen address / port | `127.0.0.1` / `8080` |
| `SSH_MCP_TOKEN` | Bearer token (one of the credential sources; all absent → refuses to start) | — |
| `SSH_MCP_TOKEN_FILE` | Read token from a 0600 file (mutually exclusive with `SSH_MCP_TOKEN`) | — |
| `SSH_MCP_TLS_CERT` / `SSH_MCP_TLS_KEY` | Built-in HTTPS for every endpoint (`scripts/gen-cert.sh` makes a cert) | off |
| `SSH_MCP_TRUST_PROXY` | `1` = trust `X-Real-IP`/`X-Forwarded-For` (legacy; prefer `auth.trustedProxies`) | off |
| `SSH_MCP_CONFIG` | Config file path | `config.json` next to the executable |

Behind Nginx, stream `POST /upload` with `proxy_request_buffering off` so GB-scale uploads never buffer to disk. Full `config.json` reference (servers, `auth.tokens` / `auth.hmac` / `auth.hmacUsers`, blacklists, rate limit, audit) is documented in the [Chinese README](README.md#configjson-说明).

**Cloud security groups only need one port: 443.** All six MCP tools plus both streaming endpoints flow through it.

## License

[MIT](LICENSE)
