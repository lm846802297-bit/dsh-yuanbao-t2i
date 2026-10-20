#!/usr/bin/env node
"use strict";
// CI · 语法检查（跨平台，必须绿）
//
//   1) node --check：对 lib/*.js + client.js + scripts/ci/*.{cjs,mjs} 做纯语法解析
//      （client.js 是 lazy-CJS，`node --check` 也能过；不执行任何代码）。
//   2) python -m py_compile：只编译 lib/wm_lama.py 验证语法
//      ⛔ 不执行它、不装 torch、不下载模型权重。
//      ⛔ 用 PYTHONPYCACHEPREFIX 把 .pyc 甩到临时目录，绝不在仓库里留 lib/__pycache__。
//
// 退出码：0 = 全过；非 0 = 有文件语法错误。

const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readdirSync } = require("node:fs");
const { join, resolve, relative } = require("node:path");
const { tmpdir } = require("node:os");
const { C } = require("./helpers.cjs");

const REPO = resolve(__dirname, "..", "..");

// 任务书点名的文件（即使目录结构变了也必须检查）
const REQUIRED_JS = [
  "lib/plugin.js",
  "lib/generate.js",
  "lib/settings.js",
  "lib/route.js",
  "lib/templates.js",
  "client.js",
];

function listCiScripts() {
  const dir = join(REPO, "scripts", "ci");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".cjs") || f.endsWith(".mjs"))
    .sort()
    .map((f) => join("scripts", "ci", f));
}

function nodeCheck(file) {
  const r = spawnSync(process.execPath, ["--check", join(REPO, file)], { encoding: "utf8" });
  if (r.error) return { ok: false, msg: String(r.error.message || r.error) };
  if (r.status !== 0) {
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    return { ok: false, msg: out || `node --check 退出码 ${r.status}` };
  }
  return { ok: true };
}

function findPython() {
  const candidates = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, [...args, "-c", "import sys; print(sys.version)"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return { cmd, args };
  }
  return null;
}

function main() {
  const failures = [];
  console.log(`${C.bold("==> node --check")}`);

  const files = [...REQUIRED_JS, ...listCiScripts()];
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    const abs = join(REPO, f);
    if (!existsSync(abs)) {
      failures.push(`${f}: 文件不存在`);
      console.log(`  ${C.red("FAIL")} ${f} — 文件不存在`);
      continue;
    }
    const r = nodeCheck(f);
    if (r.ok) {
      console.log(`  ${C.green("ok  ")} ${f}`);
    } else {
      failures.push(`${f}: ${r.msg}`);
      console.log(`  ${C.red("FAIL")} ${f}\n       ${r.msg}`);
    }
  }

  console.log(`${C.bold("==> python -m py_compile lib/wm_lama.py")}`);
  const py = findPython();
  if (!py) {
    console.log(`  ${C.yellow("note")} 没找到 python 解释器，跳过 Python 语法检查`);
    console.log(`         （CI workflow 里有 actions/setup-python，正常不会走到这里）`);
  } else {
    const cacheDir = mkdtempSync(join(tmpdir(), "yuanbao-t2i-pycache-"));
    const env = { ...process.env, PYTHONPYCACHEPREFIX: cacheDir, PYTHONDONTWRITEBYTECODE: "1" };
    const r = spawnSync(py.cmd, [...py.args, "-m", "py_compile", join(REPO, "lib", "wm_lama.py")], {
      encoding: "utf8",
      env,
    });
    if (r.error || r.status !== 0) {
      const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
      const msg = r.error ? String(r.error.message || r.error) : out || `退出码 ${r.status}`;
      failures.push(`lib/wm_lama.py: ${msg}`);
      console.log(`  ${C.red("FAIL")} lib/wm_lama.py\n       ${msg}`);
    } else {
      console.log(`  ${C.green("ok  ")} lib/wm_lama.py (${py.cmd} ${py.args.join(" ")})`);
    }
  }

  console.log(`${C.dim("仓库根目录：")}${REPO}`);
  console.log(`${C.dim("已检查文件：")}${seen.size} 个 JS + 1 个 Python`);

  if (failures.length) {
    console.log(`${C.red("FAIL")} 语法检查失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log(`${C.green("PASS")} 语法检查通过`);
  return 0;
}

process.exit(main());
