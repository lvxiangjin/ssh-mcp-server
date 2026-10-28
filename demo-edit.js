/**
 * demo-edit.js —— 演示 AI 如何非交互地修改远程文件：
 * 读 → 备份 → 改（sed 原地替换 / heredoc 整体重写）→ 验证 → 回滚
 */
import { findServer, runCommandRetry } from "./lib.js";

const s = findServer("wsl");

async function run(title, cmd) {
  const r = await runCommandRetry(s, cmd);
  console.log(`──── ${title} ────`);
  console.log(`$ ${cmd.replace(/\n/g, "\n  ")}`);
  if (!r.ok) return console.log(`执行失败: ${r.error}\n`);
  const out = (r.stdout || r.stderr).trim();
  console.log(out || "(无输出)");
  console.log("");
  return out;
}

// 1. 造一个模拟的应用配置文件（heredoc 多行写入）
await run(
  "① heredoc 写入一个配置文件",
  `cat > /tmp/app.conf <<'EOF'
port = 8080
workers = 4
log_level = info
EOF
cat /tmp/app.conf`
);

// 2. 单点修改：端口 8080 → 9090（改前先备份）
await run(
  "② 备份 + sed 原地替换 port=8080 → 9090",
  `cp /tmp/app.conf /tmp/app.conf.bak
sed -i 's/^port = .*/port = 9090/' /tmp/app.conf
echo "--- 修改后 ---"
cat /tmp/app.conf`
);

// 3. 验证：diff 对比备份
await run(
  "③ diff 验证改动",
  `diff /tmp/app.conf.bak /tmp/app.conf || true`
);

// 4. 追加一行 + 定点删除一行
await run(
  "④ 追加新行 / 删除指定行",
  `echo "timeout = 30" >> /tmp/app.conf
sed -i '/^log_level/d' /tmp/app.conf
cat /tmp/app.conf`
);

// 5. 整体重写（AI 生成完整新内容写回，适合大改）
await run(
  "⑤ heredoc 整体重写文件",
  `cat > /tmp/app.conf <<'EOF'
port = 9090
workers = 8
timeout = 60
EOF
cat /tmp/app.conf`
);

// 6. 出问题一键回滚
await run(
  "⑥ 回滚到备份版本",
  `mv /tmp/app.conf.bak /tmp/app.conf
cat /tmp/app.conf`
);

// 7. 结构化文件（JSON）也能精确改
await run(
  "⑦ python3 精确修改 JSON 字段",
  `echo '{"db":{"host":"localhost","port":3306},"debug":false}' > /tmp/app.json
python3 -c "
import json
with open('/tmp/app.json') as f: cfg = json.load(f)
cfg['db']['port'] = 3307
cfg['debug'] = True
with open('/tmp/app.json','w') as f: json.dump(cfg, f, indent=2)
"
cat /tmp/app.json`
);

await run("⑧ 清理演示文件", `rm -f /tmp/app.conf /tmp/app.json && echo 已清理`);
