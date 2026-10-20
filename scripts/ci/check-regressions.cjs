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
  assert.ok(/return\s*\{[^}]*watermarkError\s*\}/.test(src), "watermarkError 没有被返回给调用方");
});

console.log(`${C.dim("扫描文件：")}${SCAN_JS.join(", ")}`);
process.exit(checker.finish());
