#!/usr/bin/env node
/**
 * check-workflows.cjs —— workflow 结构闸（不联网、不依赖 YAML 库）
 *
 * 为什么要有它：v0.9.1 曾把「故意失败」的自测开关 `force_fail` 挂在主 CI 上，
 * 验证失败通知时每跑一次就在 ci.yml 历史里留一条红 run ⇒ 以后分不清哪条红是真回归。
 * 修法是把自测挪进 self-test.yml（commit f742270）。但那只是「这一次改对了」——
 * 没有闸，下一个人（或下一个我）顺手把开关加回来，历史照样被污染。
 *
 * 所以这里把三条结构性事实钉死：
 *   A. ci.yml 的 workflow_dispatch 不许有任何 inputs（⛔ 主 CI 不许有「故意失败」通道）
 *   B. ci.yml 的 notify 必须 uses 可复用 workflow（通知逻辑只允许有一份实现）
 *   C. notify-issue.yml 只挂 workflow_call（⛔ 不许被 push/PR 直接触发）
 *
 * ⚠️ 判定一律「按缩进的结构扫描」，⛔ 不做整文件子串匹配：
 * 注释里就会写「⛔ 别在这里加 force_fail」，子串判定会把解释禁令的注释判成违规（假阳性）。
 * 阳性对照见 scripts/ci/README-regression-locks（每条闸都注入过 bug 验红）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WF_DIR =
  process.env.YUANBAO_WF_DIR || path.join(__dirname, "..", "..", ".github", "workflows");

let pass = 0;
const fails = [];
function ok(msg) {
  pass++;
  console.log(`  ok   ${msg}`);
}
function bad(msg, detail) {
  fails.push(detail ? `${msg}（${detail}）` : msg);
  console.log(`  FAIL ${msg}${detail ? `（${detail}）` : ""}`);
}

function read(name) {
  const p = path.join(WF_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

const indentOf = (line) => line.length - line.trimStart().length;
const isComment = (line) => /^\s*#/.test(line);

/** 找出 `key:` 所在行号，并返回该键的缩进 */
function findKey(lines, key, from = 0) {
  for (let i = from; i < lines.length; i++) {
    if (isComment(lines[i])) continue;
    const m = /^(\s*)([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(lines[i]);
    if (m && m[2] === key) return { idx: i, indent: m[1].length };
  }
  return null;
}

/** 取某个键直属子块（缩进大于父键的行），到缩进回落到父级或更浅为止 */
function childBlock(lines, parent) {
  const out = [];
  for (let i = parent.idx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === "") continue;
    if (indentOf(ln) <= parent.indent) break;
    out.push(ln);
  }
  return out;
}

/** 在直属子块里找某个键（同为子块一级，即缩进＝父+2 常见形态） */
function childKey(lines, parent, key) {
  const block = childBlock(lines, parent);
  for (const ln of block) {
    if (isComment(ln)) continue;
    const m = /^(\s*)([A-Za-z_][\w-]*):/.exec(ln);
    if (m && m[2] === key) return m[1].length;
  }
  return null;
}

console.log("== workflow 结构闸 ==");

const ciRaw = read("ci.yml");
const selfRaw = read("self-test.yml");
const notifyRaw = read("notify-issue.yml");

if (!ciRaw) bad("ci.yml 不存在");
if (!selfRaw) bad("self-test.yml 不存在");
if (!notifyRaw) bad("notify-issue.yml 不存在");

if (ciRaw && selfRaw && notifyRaw) {
  const ci = ciRaw.split("\n");
  const st = selfRaw.split("\n");
  const nt = notifyRaw.split("\n");

  // A. 主 CI 的 workflow_dispatch 不许有 inputs
  const wd = findKey(ci, "workflow_dispatch");
  if (!wd) {
    bad("ci.yml 缺 workflow_dispatch（手动复跑定时链路要用）");
  } else {
    const inputsIndent = childKey(ci, wd, "inputs");
    if (inputsIndent === null) {
      ok("A. ci.yml 的 workflow_dispatch 无 inputs（主 CI 没有「故意失败」通道）");
    } else {
      bad("A. ci.yml 的 workflow_dispatch 有 inputs ⇒ 自测开关又挂回主 CI 了",
          `第 ${wd.idx + 2} 行起，inputs 在缩进 ${inputsIndent}`);
    }
  }

  // A2. 主 CI 里任何 step/job 都不许读 inputs.*
  const inputRefs = ci
    .map((ln, i) => ({ ln, i }))
    .filter(({ ln }) => !isComment(ln) && /\binputs\.[\w-]+/.test(ln));
  if (inputRefs.length === 0) {
    ok("A2. ci.yml 无任何 job/step 读取 inputs.*（自测开关彻底摘除）");
  } else {
    bad("A2. ci.yml 仍有 step 读 inputs.*",
        `第 ${inputRefs.map((r) => r.i + 1).join(", ")} 行：${inputRefs[0].ln.trim()}`);
  }

  // B. notify 必须 uses 可复用 workflow，且不许有内联 steps
  const jobs = findKey(ci, "jobs");
  if (!jobs) {
    bad("ci.yml 没有 jobs");
  } else {
    // ⚠️ 必须按「绝对行号 + 缩进」切块：先用 childBlock 把整个 jobs 子块拍平再按缩进过滤，
    //    会把前面 check job 的 steps/uses 也算进 notify（第一次就是这么误报的）。
    let notifyIdx = -1;
    for (let i = jobs.idx + 1; i < ci.length; i++) {
      const ln = ci[i];
      if (ln.trim() === "" || isComment(ln)) continue;
      if (indentOf(ln) <= jobs.indent) break; // 离开 jobs 块
      const m = /^(\s*)notify:\s*$/.exec(ln);
      if (m) {
        notifyIdx = i;
        break;
      }
    }
    if (notifyIdx === -1) {
      bad("B. ci.yml 没有 notify job");
    } else {
      const notifyBlock = childBlock(ci, { idx: notifyIdx, indent: indentOf(ci[notifyIdx]) });
      const usesLine = notifyBlock.find((ln) => !isComment(ln) && /^\s*uses:\s*\S+/.test(ln));
      const stepsLine = notifyBlock.find((ln) => !isComment(ln) && /^\s*steps:\s*$/.test(ln));
      if (usesLine && /notify-issue\.yml\s*$/.test(usesLine)) {
        ok("B. ci.yml notify 走可复用 workflow（通知逻辑只有一份实现）");
      } else {
        bad("B. ci.yml notify 没有 uses 到 notify-issue.yml", usesLine ? usesLine.trim() : "无 uses 行");
      }
      if (stepsLine) {
        bad("B2. ci.yml notify 又有内联 steps ⇒ 通知逻辑被抄成两份（改一处必漏另一处）");
      } else {
        ok("B2. ci.yml notify 无内联 steps");
      }
    }
  }

  // C. notify-issue.yml 只挂 workflow_call
  const onKey = findKey(nt, "on");
  if (!onKey) {
    bad("C. notify-issue.yml 没有 on:");
  } else {
    const onBlock = childBlock(nt, onKey);
    const triggers = onBlock
      .filter((ln) => !isComment(ln))
      .map((ln) => {
        const m = /^(\s*)([A-Za-z_][\w-]*):/.exec(ln);
        return m ? { name: m[2], indent: m[1].length } : null;
      })
      .filter(Boolean)
      // 只取触发键一级（workflow_call 的 inputs 缩进更深，不算触发键）
      .filter((t) => t.indent === Math.min(...onBlock.map(indentOf).filter((x) => x > onKey.indent)));
    const names = triggers.map((t) => t.name);
    if (names.length === 1 && names[0] === "workflow_call") {
      ok("C. notify-issue.yml 只挂 workflow_call（不会被 push/PR 直接触发）");
    } else {
      bad("C. notify-issue.yml 触发键应只有 workflow_call", `实得 [${names.join(", ")}]`);
    }
  }

  // D. 自测 workflow 自己必须能制造失败（否则「验证过」是假的）
  const stJobs = findKey(st, "jobs");
  if (!stJobs) {
    bad("D. self-test.yml 没有 jobs");
  } else {
    const hasExit1 = st.some((ln) => !isComment(ln) && /^\s*exit 1\s*$/.test(ln));
    if (hasExit1) {
      ok("D. self-test.yml 保留了「故意 exit 1」（自测真的会红）");
    } else {
      bad("D. self-test.yml 里没有 exit 1 ⇒ 「自测通知链路」永远验不出东西");
    }
    const usesNotify = st.some((ln) => !isComment(ln) && /uses:\s*\.\/\.github\/workflows\/notify-issue\.yml/.test(ln));
    if (usesNotify) {
      ok("D2. self-test.yml 复用同一份 notify-issue.yml（不会与主 CI 漂移）");
    } else {
      bad("D2. self-test.yml 没有复用 notify-issue.yml");
    }
  }
}

// ── A3/A4. 全目录级：防「未来新加的 workflow 又长出故意失败开关」─────────────
// 只在 ci.yml 上钉 A/A2 是不够的：下一个 workflow（比如将来加个 nightly.yml）照样能
// 挂 workflow_dispatch inputs 造红 run。所以把禁令提到**目录级**，只给 self-test.yml 豁免
// （它必须有开关，否则「自测通知链路」永远验不出东西）。
const FAIL_SWITCH_EXEMPT = "self-test.yml";
{
  const all = fs.existsSync(WF_DIR)
    ? fs.readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n)).sort()
    : [];
  const scanned = all.filter((n) => n !== FAIL_SWITCH_EXEMPT);
  const withInputs = [];
  const withForcedFail = [];

  for (const name of scanned) {
    const raw = read(name);
    if (!raw) continue;
    const lines = raw.split("\n");

    // (1) workflow_dispatch 不许带 inputs
    for (let i = 0; i < lines.length; i++) {
      if (isComment(lines[i])) continue;
      const m = /^(\s*)workflow_dispatch:\s*(#.*)?$/.exec(lines[i]);
      if (!m) continue;
      const blk = childBlock(lines, { idx: i, indent: m[1].length });
      if (blk.some((ln) => !isComment(ln) && /^\s*inputs:\s*$/.test(ln))) {
        withInputs.push(`${name}:${i + 1}`);
      }
    }

    // (2) 不许有「故意失败」步骤：exit <非零>
    lines.forEach((ln, i) => {
      if (isComment(ln)) return;
      if (/\bexit\s+[1-9]\d*\b/.test(ln)) withForcedFail.push(`${name}:${i + 1}`);
    });
  }

  if (scanned.length === 0) {
    bad("A3. workflows 目录里除 self-test.yml 外没有别的 workflow（扫描面为空，闸形同虚设）");
  } else if (withInputs.length === 0) {
    ok(`A3. 除 ${FAIL_SWITCH_EXEMPT} 外 ${scanned.length} 个 workflow 的 workflow_dispatch 都无 inputs`);
  } else {
    bad("A3. 有 workflow 的 workflow_dispatch 挂了 inputs ⇒ 又长了「故意失败」通道",
        `${withInputs.join("；")}（豁免只给 ${FAIL_SWITCH_EXEMPT}）`);
  }

  if (withForcedFail.length === 0) {
    ok(`A4. 除 ${FAIL_SWITCH_EXEMPT} 外 ${scanned.length} 个 workflow 无「故意失败」步骤（exit 非零）`);
  } else {
    bad("A4. 有 workflow 含故意失败步骤 ⇒ 会让主门禁历史留红 run",
        `${withForcedFail.join("；")}（要演练请放进 ${FAIL_SWITCH_EXEMPT}）`);
  }
}

console.log("");
if (fails.length) {
  for (const f of fails) console.log(`  ❌ ${f}`);
  console.log(`\nFAIL workflow 结构闸 —— ${pass} 通过 / ${fails.length} 未通过`);
  process.exit(1);
}
console.log(`PASS workflow 结构闸 —— ${pass} 项断言全部通过`);
