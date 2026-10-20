#!/usr/bin/env node
"use strict";
// CI · 掩膜检测闸门（需 python + numpy + Pillow）
//
// 跑 scripts/ci/test-mask-gates.py：在合成图上钉死「该降级时降级、该精确时精确」。
// 为什么值得单独一器：v0.9.0 及以前的检测口径有真 bug —— 3/8 张真样本掩膜近空
// （命中 0.65% / 0.07% / 0.00%）⇒ 水印原样留着，**语法合法、不报错、只是没做成**。
// 静态锁（check-regressions ⑨）只能防「有人把代码改回去」，跑不了行为；
// 这一个器能真的跑检测函数。
//
// 解释器选择：DSH_LAMA_PYTHON / DSH_PYTHON（显式指定，指定了就必须能用，坏了解包成 FAIL）
//             → py -3 / python / python3 里**第一个能 import numpy+PIL 的**。
//             一个都找不到 ⇒ 打 SKIP 并 exit 0（环境缺依赖不是代码回归；CI 里装了 numpy，
//             workflow 会 pip install，所以正常永远走到真跑，不会恒绿）。
//
// 退出码：0 = 全过或跳过；非 0 = 有断言失败 / 显式指定的解释器不可用。

const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync } = require("node:fs");
const { join, resolve, relative } = require("node:path");
const { tmpdir } = require("node:os");
const { C } = require("./helpers.cjs");

const REPO = resolve(__dirname, "..", "..");
const TARGET = join(REPO, "scripts", "ci", "test-mask-gates.py");
const PROBE = "import numpy, PIL; print('ok')";

function tryInterpreter(cmd, args) {
  const r = spawnSync(cmd, [...args, "-c", PROBE], { encoding: "utf8" });
  if (r.error) return { ok: false, reason: String(r.error.message || r.error) };
  if (r.status !== 0) {
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").pop();
    return { ok: false, reason: out || `退出码 ${r.status}` };
  }
  return { ok: true };
}

function choosePython() {
  const explicit = [
    ["DSH_LAMA_PYTHON", process.env.DSH_LAMA_PYTHON],
    ["DSH_PYTHON", process.env.DSH_PYTHON],
  ].filter(([, v]) => v && String(v).trim());
  for (const [name, exe] of explicit) {
    const r = tryInterpreter(exe, []);
    if (r.ok) return { cmd: exe, args: [], via: name };
    console.log(`  ${C.red("FAIL")} ${name}=${exe} 不可用/缺 numpy：${r.reason}`);
    console.log(`         显式指定的解释器不可用 ⇒ 视为失败（别静默跳过）`);
    return { error: `${name} 指向的解释器不可用` };
  }
  const cands = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  const misses = [];
  for (const [cmd, args] of cands) {
    const r = tryInterpreter(cmd, args);
    if (r.ok) return { cmd, args, via: "自动探测" };
    misses.push(`${cmd} ${args.join(" ")}：${r.reason}`);
  }
  return { skip: misses };
}

function main() {
  if (!existsSync(TARGET)) {
    console.log(`  ${C.red("FAIL")} 找不到 ${relative(REPO, TARGET)}`);
    return 1;
  }
  console.log(`${C.bold("==> 掩膜检测闸门（scripts/ci/test-mask-gates.py）")}`);

  const py = choosePython();
  if (py.error) return 1;
  if (py.skip) {
    console.log(`  ${C.yellow("SKIP")} 没找到装了 numpy+Pillow 的 python 解释器`);
    for (const m of py.skip) console.log(`         ${C.dim(m)}`);
    console.log(`         说明：CI 里会 pip install numpy pillow，所以 CI 永远真跑；`);
    console.log(`         本地想跑：设 DSH_LAMA_PYTHON=<装了 numpy 的解释器> 后重跑 npm run ci`);
    return 0;
  }
  console.log(`  ${C.dim("解释器：")}${py.cmd} ${py.args.join(" ")} ${C.dim(`（${py.via}）`)}`);

  const cacheDir = mkdtempSync(join(tmpdir(), "yuanbao-t2i-maskpycache-"));
  const r = spawnSync(py.cmd, [...py.args, TARGET], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONPYCACHEPREFIX: cacheDir,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  for (const line of out.split("\n")) if (line.trim()) console.log(`  ${line}`);
  if (r.error || r.status !== 0) {
    console.log(`${C.red("FAIL")} 掩膜闸门未通过（退出码 ${r.status}）`);
    return 1;
  }
  console.log(`${C.green("PASS")} 掩膜闸门 —— 合成图行为断言全部通过`);
  return 0;
}

process.exit(main());
