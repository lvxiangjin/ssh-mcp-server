/**
 * test-mcp.js —— 完整走一遍 MCP 协议：把 server.js 作为 stdio 子进程拉起，
 * 用 MCP 客户端 list_tools / call_tool，模拟 AI 客户端的真实调用方式。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "server.js")],
});
const client = new Client({ name: "ssh-mcp-test-client", version: "0.0.1" });
await client.connect(transport);

const textOf = (res) => res.content?.map((c) => c.text).join("\n") ?? "";

const tools = await client.listTools();
console.log("== MCP list_tools ==", tools.tools.map((t) => t.name).join(", "));

const ls = await client.callTool({ name: "list_servers", arguments: {} });
console.log("\n== MCP list_servers ==");
console.log(textOf(ls));

const res = await client.callTool({
  name: "run_command",
  arguments: { command: "echo MCP_CALL_OK from $(hostname) && uname -r" },
});
console.log("\n== MCP run_command（正常） ==");
console.log(textOf(res));

const blocked = await client.callTool({
  name: "run_command",
  arguments: { command: "rm -rf / --no-preserve-root" },
});
console.log("\n== MCP run_command（危险命令） ==");
console.log(textOf(blocked));

await client.close();
process.exit(0);
