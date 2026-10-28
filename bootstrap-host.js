/**
 * bootstrap-host.js —— 一次性引导：密码登录目标服务器，装入本机公钥（之后全程密钥认证）
 * 用法：node bootstrap-host.js <host> <user> <password>
 * 公钥来源：~/.ssh/id_ed25519.pub（不存在则自动生成）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";

const { Client } = ssh2;
const [host, user, password] = process.argv.slice(2);
if (!host || !user || !password) {
  console.error("用法: node bootstrap-host.js <host> <user> <password>");
  process.exit(1);
}

const pubPath = path.join(os.homedir(), ".ssh", "id_ed25519.pub");
if (!fs.existsSync(pubPath)) {
  console.error("缺少本机公钥，请先 ssh-keygen");
  process.exit(1);
}
const pubkey = fs.readFileSync(pubPath, "utf8").trim();

const conn = new Client();
conn
  .on("ready", () => {
    const cmd =
      "mkdir -p /root/.ssh && chmod 700 /root/.ssh && " +
      `touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && ` +
      `grep -qF '${pubkey.split(" ")[1]}' /root/.ssh/authorized_keys 2>/dev/null || ` +
      `echo ${JSON.stringify(pubkey)} >> /root/.ssh/authorized_keys; ` +
      `echo INSTALLED; uname -m; grep PRETTY /etc/os-release 2>/dev/null | head -1`;
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error("exec err:", err.message); process.exit(1); }
      let out = "", er = "";
      stream.on("data", (d) => (out += d));
      stream.stderr.on("data", (d) => (er += d));
      stream.on("close", (code) => {
        console.log(`exit=${code}`);
        console.log(out.trim());
        if (er.trim()) console.log("stderr:", er.trim());
        conn.end();
        process.exit(code === 0 ? 0 : 1);
      });
    });
  })
  .on("error", (e) => {
    console.error("连接失败:", e.message);
    process.exit(1);
  })
  .connect({
    host,
    port: 22,
    username: user,
    password,
    readyTimeout: 15000,
  });
