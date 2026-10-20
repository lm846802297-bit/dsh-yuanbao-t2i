"use strict";
// CI 探针公共件：统一的断言计数 / 失败汇总 / 退出码。
//
// 约定（所有 scripts/ci/*.cjs 遵守）：
//   - 每条断言失败都要打印可读原因；
//   - 全部通过 → exit 0；有断言失败 → exit 非 0；
//   - 绝不联网、绝不启动浏览器、绝不装 torch。

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const C = {
  green: (s) => (useColor ? `\u001b[32m${s}\u001b[0m` : s),
  red: (s) => (useColor ? `\u001b[31m${s}\u001b[0m` : s),
  yellow: (s) => (useColor ? `\u001b[33m${s}\u001b[0m` : s),
  dim: (s) => (useColor ? `\u001b[2m${s}\u001b[0m` : s),
  bold: (s) => (useColor ? `\u001b[1m${s}\u001b[0m` : s),
};

function errMessage(e) {
  if (!e) return "unknown error";
  if (e.code === "ERR_ASSERTION") return e.message;
  return e.message ? `${e.message}` : String(e);
}

function createChecker(title) {
  const failures = [];
  let passed = 0;

  function step(msg) {
    console.log(`${C.bold("==>")} ${msg}`);
  }
  function note(msg) {
    console.log(`${C.yellow("note")} ${msg}`);
  }
  function check(desc, fn) {
    try {
      const r = fn();
      if (r && typeof r.then === "function") {
        throw new Error("check() 不接受异步断言，请改用 acheck()");
      }
      passed += 1;
      console.log(`  ${C.green("ok  ")} ${desc}`);
      return r;
    } catch (e) {
      failures.push({ desc, err: e });
      console.log(`  ${C.red("FAIL")} ${desc}`);
      console.log(`       ${C.dim(errMessage(e))}`);
      return undefined;
    }
  }
  // 异步版断言：断言函数可以 await（路由探针要 await handler(...)）。
  async function acheck(desc, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  ${C.green("ok  ")} ${desc}`);
      return true;
    } catch (e) {
      failures.push({ desc, err: e });
      console.log(`  ${C.red("FAIL")} ${desc}`);
      console.log(`       ${C.dim(errMessage(e))}`);
      return false;
    }
  }
  function finish() {
    if (failures.length === 0) {
      console.log(`${C.green("PASS")} ${title} — ${passed} 项断言全部通过`);
      return 0;
    }
    console.log(`${C.red("FAIL")} ${title} — ${failures.length}/${passed + failures.length} 项断言失败：`);
    for (const f of failures) console.log(`  - ${f.desc}: ${errMessage(f.err)}`);
    return 1;
  }
  return { step, note, check, acheck, finish, get failures() { return failures; } };
}

module.exports = { C, createChecker, errMessage };
