#!/usr/bin/env node
/**
 * gen-token.js —— 生成 64 位十六进制强随机 Token
 * 用途：SSH_MCP_TOKEN 环境变量 / config.json auth.tokens[].token
 * 用法：node scripts/gen-token.js
 */
import crypto from "node:crypto";

console.log(crypto.randomBytes(32).toString("hex"));
