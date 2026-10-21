#!/usr/bin/env node
"use strict";
// CI · 历史回归锁（静态契约）
//
// 为什么单独有这个文件：下面每一条都对应**真实发生过、而 node --check / 单元探针都抓不到**的 bug。
// 它们的共同特征是「语法合法、类型合法、运行不报错，只是静默做错事」——
// 只有真机跑一遍才会暴露（v0.8.0 那次就是靠 DSH 宿主日志里一行被 catch 吞掉的错误才发现的）。
// 静态锁不贵，但能把这几种「静默失错」钉死在提交前。
//
//   ① cleanWatermark 调用点必须显式传 log
//      → 反例（v0.8.0 线上）：cleanWatermark(r.files, { outDir, ...wmCfg }) 漏传 log，
//        内部 log() 抛 "log is not a function" 被 catch 吞掉 ⇒ removeWatermark:true 时
//        去水印根本没跑，却返回 ok:true + 带水印原图。
//   ② cleanWatermark 签名里 log 必须有缺省值（内部裸调用不再致命）。
//   ③ 禁止字面反斜杠分割：split("\\n")  —— 源码里两个字符 \ + n，不是换行
//      → 反例（v0.6.0 已发布）：SSE 整段被当一行 ⇒ JSON.parse 全失败 ⇒ 取图恒为 0 张。
//   ④ 禁止空 catch 块 —— 静默失败温床。
//   ⑤ 禁止再依赖 window.__YUANBAO_PENDING_IMAGES__ 注入
//      → 已实测证伪（v0.6.1 抓包：请求体 multimedia:[] 为空），元宝前端不读这个变量。
//   ⑥ 去水印失败的 catch 分支必须给 watermarkError 赋值并返回（否则静默无信号）。
//   ⑦ 禁止再引入永久无效的 seed 参数（协议层 extra.image_gen_param 根本没有 seed 落点）。
//   ⑧ 修复范围（wmMask）不得再回到公开面：入参 schema 不许有、client.js 界面不许出现
//      → v0.10.0 撤掉该用户开关（改内部自适应 auto + DSH_WM_MASK 兜底），撤了就锁住。
//   ⑩ 输出 schema 里的 style 不许直传 null（无画风调用会被宿主判 invalid output）
//   ⑨ wm_lama 检测口径不许退回旧 bug：--mask 缺省 auto 且三档都在、代码里没有分位数检测
//      （percentile / p99.5 / p0.5）、可信度闸与残痕自检常量都在
//      → 去水印质量全压在 auto 分支上，这类回归语法合法、只是让图悄悄变糊。
//
// 退出码：0 = 全过；非 0 = 有断言失败。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createChecker, C } = require("./helpers.cjs");

const REPO = path.resolve(__dirname, "..", "..");
const checker = createChecker("历史回归锁");

const LIB = path.join(REPO, "lib");
const SCAN_JS = [
  ...fs
    .readdirSync(LIB)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join("lib", f)),
  "client.js",
].filter((rel) => fs.existsSync(path.join(REPO, rel)));

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// 从 start（指向 "(" 的位置）起取出配对括号内的文本
function balancedArgs(src, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

// 从 openIdx（指向 "{" / "(" / "[" 的位置）起取出配对块**内部**的文本。
// 与 balancedArgs 的区别：① 支持花括号 ② 跳过字符串与注释，免得 schema 描述文案里的
// 花括号/引号把配对算歪（描述里写了个 "{" 就会让朴素的计数法切错位置）。
function balancedBlock(src, openIdx) {
  const open = src[openIdx];
  const close = open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

function positional(rel, needle) {
  const src = read(rel);
  const hits = [];
  let idx = src.indexOf(needle);
  while (idx !== -1) {
    hits.push({ src, idx });
    idx = src.indexOf(needle, idx + needle.length);
  }
  return hits;
}

// 逐行判定 lib/wm_lama.py 的「代码行」：跳过 `#` 注释行与三引号文档串。
// 为什么要跳过：文档串里**允许**写「旧实现用 p99.5 / p0.5 两端二选一」这类历史说明
// ——那是事故记录，不是检测口径。锁的是代码，不是注释（同 ⑦ 的口径）。
function pythonCodeLines(src) {
  const out = [];
  let fence = null;
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (fence) {
      if (t.includes(fence)) fence = null;
      return;
    }
    for (const f of ['"""', "'''"]) {
      if (t.startsWith(f)) {
        if (t.split(f).length - 1 >= 2) return; // 单行文档串（"""xxx"""）
        fence = f;
        return;
      }
    }
    if (t.startsWith("#")) return;
    out.push({ n: i + 1, text: line });
  });
  return out;
}

checker.step("① cleanWatermark 调用点必须显式传 log");
checker.check("每个 cleanWatermark(...) 调用都带了 log", () => {
  const problems = [];
  for (const rel of SCAN_JS) {
    for (const { src, idx } of positional(rel, "cleanWatermark(")) {
      // 跳过函数定义本身
      const head = src.slice(Math.max(0, idx - 40), idx);
      if (/function\s*$/.test(head)) continue;
      const args = balancedArgs(src, idx + "cleanWatermark".length);
      if (args === null) {
        problems.push(`${rel}: cleanWatermark 调用括号不配对`);
        continue;
      }
      if (!/\blog\b/.test(args)) {
        const line = src.slice(0, idx).split("\n").length;
        problems.push(`${rel}:${line} 漏传 log ⇒ 去水印会静默失败（返回带水印原图却报 ok）`);
      }
    }
  }
  assert.equal(problems.length, 0, problems.join("；"));
});

checker.step("② cleanWatermark 签名里 log 有缺省值");
checker.check("签名形如 { ..., log = ... }（内部裸调用不再致命）", () => {
  const src = read("lib/plugin.js");
  const idx = src.indexOf("function cleanWatermark(");
  assert.ok(idx !== -1, "找不到 function cleanWatermark(");
  const params = balancedArgs(src, idx + "function cleanWatermark".length);
  assert.ok(params, "cleanWatermark 参数表括号不配对");
  assert.ok(/\blog\s*=/.test(params), "log 没有缺省值：内部裸调用会抛 log is not a function");
});

checker.step('③ 禁止字面反斜杠分割 split("\\\\n")（v0.6.0 取图恒 0 张回归锁）');
checker.check("lib/*.js 与 client.js 里没有 split 到字面 \\n 的写法", () => {
  // 目标形态：源码里 split 的参数是「两个反斜杠 + n」（字面反斜杠，v0.6.0 的 bug 写法）。
  // 正则里 \\\\n = 两个反斜杠 + n；⛔ 写成 \\n 会匹配到正确写法（一个反斜杠 + n）⇒ 变成误报。
  // 已用 /tmp/re_semantics.cjs 双向验证：该正则对正确写法 false、对 bug 写法 true。
  const bad = /\.split\(\s*(["'])\\\\n\1\s*\)/;
  const problems = [];
  for (const rel of SCAN_JS) {
    const src = read(rel);
    src.split("\n").forEach((line, i) => {
      if (bad.test(line)) problems.push(`${rel}:${i + 1} ${line.trim()}`);
    });
  }
  assert.equal(problems.length, 0, `发现字面反斜杠分割（应为真换行 "\\n"）：\n${problems.join("\n")}`);
});

checker.step("④ 禁止空 catch 块");
checker.check("lib/*.js 与 client.js 里没有 catch (...) {}", () => {
  const emptyCatch = /catch\s*(\([^)]*\))?\s*\{\s*\}/;
  const problems = [];
  for (const rel of SCAN_JS) {
    const src = read(rel);
    src.split("\n").forEach((line, i) => {
      if (emptyCatch.test(line)) problems.push(`${rel}:${i + 1} 空 catch ⇒ 错误被静默吞掉`);
    });
  }
  assert.equal(problems.length, 0, problems.join("；"));
});

checker.step("⑤ 禁止再依赖已证伪的 window.__YUANBAO_PENDING_IMAGES__ 注入");
checker.check("源码里没有 __YUANBAO_PENDING_IMAGES__", () => {
  const problems = [];
  for (const rel of SCAN_JS) {
    if (read(rel).includes("__YUANBAO_PENDING_IMAGES__")) {
      problems.push(`${rel}: 仍引用该注入点（v0.6.1 已实测证伪：请求体 multimedia 为空）`);
    }
  }
  assert.equal(problems.length, 0, problems.join("；"));
});

checker.step("⑥ 去水印失败时必须有可观测出口（watermarkError）");
checker.check("catch 分支里给 watermarkError 赋值，且返回值带上它", () => {
  const src = read("lib/plugin.js");
  // 光看「文件里出现过 watermarkError = 」不够（let 声明、schema 都能蒙混过关）——
  // 必须落在 catch 块里，否则去水印失败时调用方拿不到任何信号。
  const inCatch = /catch\s*\([^)]*\)\s*\{[^}]*watermarkError\s*=/.test(src);
  assert.ok(inCatch, "没有在 catch 分支里给 watermarkError 赋值 ⇒ 去水印失败静默无信号");
  // ⚠️ ⛔ 别用 /return\s*\{[^}]*watermarkError/ —— 返回值里一旦出现嵌套花括号
  //    （例如 `...(cond ? { style } : {})`），[^}]* 会在内层 } 处停住 ⇒ 假红。
  //    改成按行取「以 return { 开头」的语句，只要该行带上 watermarkError 就算带出。
  const retLine = src
    .split(/\r?\n/)
    .filter((line) => /return\s*\{/.test(line))
    .find((line) => /watermarkError\b/.test(line));
  assert.ok(retLine, "watermarkError 没有被返回给调用方");
});

checker.step("⑦ 禁止再引入永久无效的 seed 参数");
checker.check("工具入参/出参 schema 与生成器里都没有 seed（协议层无落点）", () => {
  // v0.9.0 删掉了 seed：元宝 extra.image_gen_param 结构上只有 model/ratio/resolution 三个键，
  // seed 从来没起过作用，只是把值原样回显。留着的唯一后果＝让调用方以为能锁种子。
  const problems = [];
  for (const rel of ["lib/plugin.js", "lib/generate.js"]) {
    const src = read(rel);
    src.split("\n").forEach((line, i) => {
      if (/\bseed\b/i.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
        problems.push(`${rel}:${i + 1} ${line.trim()}`);
      }
    });
  }
  assert.equal(problems.length, 0, `又出现了 seed（永久不生效，⛔ 别再加回来）：\n${problems.join("\n")}`);
});

checker.step("⑧ 修复范围（wmMask）不得再回到公开面");
// 为什么锁这条：v0.10.0 撤掉「修复范围」这个用户开关（改由 wm_lama.py 内部自适应 auto，
// 只留环境变量 DSH_WM_MASK 兜底）。撤开关这类改动最容易被「顺手加回来」——加回 schema 或
// 加回界面都不会报错，只会让用户重新背上一个他没必要的选择。所以锁在提交前。
//
// ⚠️ 锁的射程必须**分而治之**：lib/plugin.js 内部合法保留 wmMask（wmCfg 键 + 交给
//    cleanWatermark 的字段），所以只扫 yuanbao_t2i 那个 `parameters: { ... }` 块内部；
//    client.js 是纯界面，撤了就整文件不该再出现。
checker.check("yuanbao_t2i 的入参 schema 里没有 wmMask", () => {
  const src = read("lib/plugin.js");
  const anchor = 'name: "yuanbao_t2i",';
  const at = src.indexOf(anchor);
  assert.ok(at !== -1, `plugin.js 里找不到工具注册锚点 ${anchor} —— 工具结构变了，本锁需同步更新`);
  // 从锚点往后找第一个 parameters 块 ⇒ 它就是 yuanbao_t2i 自己的
  const kw = "parameters: {";
  const pIdx = src.indexOf(kw, at);
  assert.ok(pIdx !== -1, `${anchor} 之后找不到 ${kw}`);
  // 自证「取到的是 t2i 而不是 styles」：styles 工具必须在它后面
  const stylesAt = src.indexOf('name: "yuanbao_t2i_styles",');
  assert.ok(stylesAt === -1 || stylesAt > pIdx, "取到的 parameters 块属于 yuanbao_t2i_styles，本锁取错位置了");
  const body = balancedBlock(src, pIdx + kw.length - 1);
  assert.ok(body !== null, "yuanbao_t2i 的 parameters 块括号没配上（源码被截断？）");
  // 自证「取到的确实是 schema 本体」：必须含已知参数名，否则是切了个空块出来、锁会恒绿
  assert.ok(
    /\bprompt\b/.test(body) && /\bwmEngine\b/.test(body),
    `取到的 parameters 块不含 prompt/wmEngine，怀疑切错：${body.slice(0, 120)}`,
  );
  assert.ok(
    !/\bwmMask\b/.test(body),
    "yuanbao_t2i 入参 schema 里又出现了 wmMask —— v0.10.0 已撤下该公开参数（改内部自适应 auto + DSH_WM_MASK 兜底）",
  );
});

checker.check("插件内部仍把掩膜值交给 cleanWatermark（wmMask 只是不再是入参）", () => {
  // 撤参数 ≠ 撤功能：内部还得把 auto（或 DSH_WM_MASK 兜底值）传给去水印管线，
  // 否则去水印会退回 wm_lama.py 的隐含缺省、行为漂移且无人发现。
  const src = read("lib/plugin.js");
  assert.ok(
    /wmMask:\s*WM_MASK_DEFAULT/.test(src),
    "plugin.js 里没有 `wmMask: WM_MASK_DEFAULT` —— 内部掩膜值没传给 cleanWatermark",
  );
  const line = src.split("\n").find((l) => /const\s+WM_MASK_DEFAULT\s*=/.test(l));
  assert.ok(line, "找不到 WM_MASK_DEFAULT 的定义行");
  assert.ok(/"auto"/.test(line), `WM_MASK_DEFAULT 的兜底值不是 "auto"：${line.trim()}`);
  assert.ok(/WM_MASK_ENV/.test(line), `WM_MASK_DEFAULT 没有走 DSH_WM_MASK 环境变量兜底：${line.trim()}`);
});

checker.check("client.js（用户界面）里不再出现已撤下的修复范围开关", () => {
  const src = read("client.js");
  const banned = ["wmMask", "修复范围", "maskTight", "maskRect", "Repair area"];
  const hit = banned.filter((t) => src.includes(t));
  assert.equal(hit.length, 0, `界面里又出现了已撤下的开关字段/文案：${hit.join(", ")}`);
});

checker.step("⑨ wm_lama 检测口径不许退回旧 bug（CLI 契约 + 可信度闸 + 残痕自检）");
// 为什么锁这条：lib/plugin.js 现在默认传 --mask auto，去水印质量的**全部**风险都压在
// lib/wm_lama.py 的 auto 分支上。它曾经的真事故是「分位数两端二选一、命中 0.07% 被当成
// 更干净的那端 ⇒ 掩膜为空 ⇒ 退回整块重绘」——这类回归**语法合法、跑起来不报错**，
// 只会让图悄悄变糊，所以钉死在提交前（口径与 ⑦ 一致：只扫代码，不扫注释/文档串）。
function pyArgCall(py, flag) {
  // 取 `ap.add_argument("<flag>" ...)` 这个调用的实参文本（配对小括号）。
  // ⚠️ 括号在 flag 之前（add_argument( ），所以必须先回退找到 add_argument 再往后取 "("
  //    ——否则会取到**下一个**参数的实参（本锁第一版就这么错过一次，结果报错文本指到了 --thr）。
  const at = py.indexOf(`"${flag}"`);
  if (at === -1) return null;
  const call = py.lastIndexOf("add_argument", at);
  if (call === -1) return null;
  const open = py.indexOf("(", call);
  if (open === -1 || open > at) return null;
  return balancedArgs(py, open);
}

checker.check("--mask 缺省 auto，且三档 auto/tight/rect 都还在 choices 里", () => {
  const py = read("lib/wm_lama.py");
  const arg = pyArgCall(py, "--mask");
  assert.ok(arg, "wm_lama.py 里找不到 --mask 的 add_argument —— CLI 契约变了，本锁需同步更新");
  assert.ok(/default\s*=\s*["']auto["']/.test(arg), `--mask 的缺省值不是 auto：${arg.trim()}`);
  const choices = /choices\s*=\s*\[([^\]]*)\]/.exec(arg);
  assert.ok(choices, `--mask 没有 choices 列表：${arg.trim()}`);
  const modes = choices[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .sort();
  assert.deepEqual(modes, ["auto", "rect", "tight"], `--mask 的可选值应恰好是 auto/rect/tight，实际 ${JSON.stringify(modes)}`);
});

checker.check("代码里没有分位数检测（percentile / p99.5 / p0.5）—— 旧 bug 的根", () => {
  const py = read("lib/wm_lama.py");
  const code = pythonCodeLines(py);
  // 自证「剥壳后仍是真代码」：否则一旦剥空，本断言会恒绿
  const joined = code.map((c) => c.text).join("\n");
  assert.ok(
    /\bdef\s+build_tight_mask\b/.test(joined) && /\bMIN_HIT\b/.test(joined),
    "剥掉注释/文档串后没找到 build_tight_mask / MIN_HIT —— 剥壳逻辑失手，本断言不可信",
  );
  const banned = ["percentile", "quantile", "p99.5", "p0.5", "p99_5", "p0_5"];
  const hits = [];
  for (const { n, text } of code) {
    for (const t of banned) {
      if (text.includes(t)) hits.push(`lib/wm_lama.py:${n} ${text.trim()} （命中 ${t}）`);
    }
  }
  assert.equal(
    hits.length,
    0,
    `检测口径又退回分位数了（v0.10.0 已改成「位置先验 + 局部中值背景 + MAD 阈值」）：\n${hits.join("\n")}`,
  );
});

checker.check("可信度闸（MIN_HIT / MAX_HIT / SELF_CHECK_RATIO）与残痕自检都在", () => {
  const py = read("lib/wm_lama.py");
  for (const name of ["MIN_HIT", "MAX_HIT", "SELF_CHECK_RATIO"]) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*([0-9.]+)`, "m").exec(py);
    assert.ok(m, `wm_lama.py 里缺少常量 ${name} 的赋值 —— 可信度闸/残痕自检被人删掉了`);
    const v = Number(m[1]);
    assert.ok(v > 0 && v <= 1, `${name} = ${m[1]} 不在 (0, 1] 内，闸门形同虚设`);
  }
  const minHit = Number(/^\s*MIN_HIT\s*=\s*([0-9.]+)/m.exec(py)[1]);
  const maxHit = Number(/^\s*MAX_HIT\s*=\s*([0-9.]+)/m.exec(py)[1]);
  assert.ok(minHit < maxHit, `MIN_HIT(${minHit}) 必须小于 MAX_HIT(${maxHit})，否则区间为空、auto 恒降级`);
  const sc = pyArgCall(py, "--selfcheck");
  assert.ok(sc, "wm_lama.py 里找不到 --selfcheck 参数 —— 残痕自检的开关被删了");
  assert.ok(/default\s*=\s*["']1["']/.test(sc), `--selfcheck 的缺省值不是 "1"（自检默认关＝静默放行残痕）：${sc.trim()}`);
});

checker.step("⑩ 输出 schema 的 style 不许直传 null（无画风调用会被宿主判 invalid output）");
checker.check("plugin.js 的返回对象里 style 必须是「有才带」而不是直传 r.style", () => {
  const js = read("lib/plugin.js");
  // ① 禁止未加保护的直传形态（这是真事故写法）
  // 先把「受保护的写法」整段摘掉，再找裸直传（否则保护形态自己会被判红）
  const guarded = /\.\.\.\s*\(\s*r\.style\s*\?\s*\{\s*style:\s*r\.style\s*\}\s*:\s*\{\s*\}\s*\)/g;
  const bare = js.replace(guarded, "/* guarded */");
  const bad = /\bstyle:\s*r\.style\b/.exec(bare);
  assert.ok(
    !bad,
    "plugin.js 里出现 `style: r.style` 直传 —— r.style 在「不传 style 参数」时是 null，" +
      "而输出 schema 把 style 声明为 object ⇒ 宿主会判 returned invalid output，" +
      "调用方拿不到结果（图已落盘却报错，v0.10.0 真机实测）。正解：...(r.style ? { style: r.style } : {})",
  );
  // ② 必须存在「有才带」的保护形态（防止有人直接删掉 style 输出，画风信息丢失）
  assert.ok(
    /\.\.\.\s*\(\s*r\.style\s*\?\s*\{\s*style:\s*r\.style\s*\}\s*:\s*\{\s*\}\s*\)/.test(js),
    "plugin.js 里找不到 `...(r.style ? { style: r.style } : {})` —— 要么被改回直传，要么 style 输出整块丢了",
  );
  // ③ schema 里 style 不得进 required（缺 style 必须是合法返回）
  const req = /required:\s*\[([^\]]*)\]/.exec(js);
  assert.ok(req, "plugin.js 里找不到输出 schema 的 required 列表");
  assert.ok(
    !/[\"']style[\"']/.test(req[1]),
    `输出 schema 把 style 写进了 required（${req[1].trim()}）—— 不传画风的调用会被判缺字段`,
  );
});

console.log(`${C.dim("扫描文件：")}${SCAN_JS.join(", ")}`);
process.exit(checker.finish());
