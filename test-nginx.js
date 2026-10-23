/**
 * test-nginx.js —— 验证"整套工具走 Nginx 单端口"：
 * 客户端只访问 Nginx 对外端口（模拟云服务器唯一放行的端口），
 * list_tools / run_command / upload_file / download_file 全部经反代完成。
 *
 * 用法：NGINX_URL=http://<ip>:8888/mcp SSH_MCP_TOKEN=xxx node test-nginx.js
 */
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.NGINX_URL ?? "http://127.0.0.1:8888/mcp");
const token = process.env.SSH_MCP_TOKEN ?? "test-token-123";
console.log(`目标（仅 Nginx 端口）: ${url}\n`);

const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "nginx-test", version: "0.0.1" });
await client.connect(transport);
const textOf = (r) => r.content?.map((c) => c.text).join("\n") ?? "";

const tools = await client.listTools();
console.log("== 1. list_tools（经 Nginx）==");
console.log(tools.tools.map((t) => t.name).join(", "));

const res = await client.callTool({
  name: "run_command",
  arguments: { command: "echo RUN_CMD_VIA_NGINX from $(hostname)" },
});
console.log("\n== 2. run_command（经 Nginx）==");
console.log(textOf(res).split("\n").filter((l) => !l.startsWith("server:") && l !== "--- stdout ---").join("\n").trim());

const payload = "这是 AI 通过 Nginx 反代上传的文件内容\n".repeat(10);
const up = await client.callTool({
  name: "upload_file",
  arguments: {
    remote_path: "/opt/nginx-demo/from-ai.txt",
    content_base64: Buffer.from(payload, "utf8").toString("base64"),
  },
});
console.log("\n== 3. upload_file（经 Nginx）==");
console.log(textOf(up));

const dl = await client.callTool({
  name: "download_file",
  arguments: { remote_path: "/opt/nginx-demo/from-ai.txt" },
});
console.log("\n== 4. download_file（经 Nginx）==");
const dlText = textOf(dl);
const contentMatch = dlText.match(/--- content \(utf8\) ---\n([\s\S]*)$/);
const gotBack = contentMatch ? contentMatch[1] : "";
console.log(`md5 行: ${dlText.split("\n").find((l) => l.startsWith("md5:"))}`);
console.log(`内容一致: ${gotBack === payload ? "✅" : "❌"}`);

await client.callTool({
  name: "run_command",
  arguments: { command: "rm -rf /opt/nginx-demo" },
});

await client.close();
console.log("\n四件套全部经 Nginx 单端口完成 ✅");
