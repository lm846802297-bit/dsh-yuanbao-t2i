#!/usr/bin/env node
"use strict";
// CI · 路由探针（不联网 / 不启动浏览器 / 不碰真实用户配置）
//
// 打 lib/route.js 注册的 /yuanbao-t2i/config 路由：
//   GET    → 200
//   POST {wmEngine:"telea"} → 200，且落盘后被 sanitize 回落为 "lama"（telea 已下架）
//   DELETE → 405
//
// ⚠️ lib/settings.js 读写 ~/.dsh/yuanbao-t2i-config.json（源码 lib/settings.js:8-9 读
//    process.env.DSH_YUANBAO_SETTINGS）⇒ 本探针 **必须** 先把该环境变量指到临时目录，
//    否则会污染真实用户配置。脚本启动即设置（早于任何 import），并额外断言：
//    ① SETTINGS_PATH 确实落在临时目录里；
//    ② 真实配置文件（若存在）mtime/size 在整个探针过程中没变。
//
// 退出码：0 = 全过；非 0 = 有断言失败。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createChecker, C } = require("./helpers.cjs");

const REPO = path.resolve(__dirname, "..", "..");
const checker = createChecker("路由探针");

// ── 1) 把配置路径重定向到临时目录（必须早于 lib/settings.js 的模块求值）────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yuanbao-t2i-ci-"));
const SETTINGS_FILE = path.join(TMP_DIR, "yuanbao-t2i-config.json");
process.env.DSH_YUANBAO_SETTINGS = SETTINGS_FILE;

const REAL_SETTINGS_FILE = path.join(os.homedir(), ".dsh", "yuanbao-t2i-config.json");
function statSafe(p) {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
const realBefore = statSafe(REAL_SETTINGS_FILE);

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || null;
      return this; // route.js 里 `res.writeHead(405).end()` 依赖这个链式返回
    },
    end(payload) {
      if (payload !== undefined && payload !== null) this.body += String(payload);
      return this;
    },
  };
}

function makeReq(method, body) {
  const req = { method, url: "/yuanbao-t2i/config", headers: {} };
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const buf = Buffer.from(JSON.stringify(body === undefined ? {} : body), "utf8");
    req[Symbol.asyncIterator] = async function* () {
      yield buf;
    };
  }
  return req;
}

async function callRoute(route, method, body) {
  const res = makeRes();
  await route.handler(makeReq(method, body), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* 非 JSON 响应（405 走的是 res.writeHead(405).end()，body 为空） */
  }
  return { status: res.status, body: res.body, json };
}

(async () => {
  checker.step("准备临时配置目录");
  console.log(`  ${C.dim("DSH_YUANBAO_SETTINGS=")}${SETTINGS_FILE}`);

  let route;
  let SETTINGS_PATH;
  try {
    const settingsMod = await import(pathToFileURL(path.join(REPO, "lib", "settings.js")).href);
    SETTINGS_PATH = settingsMod.SETTINGS_PATH;
    const routeMod = await import(pathToFileURL(path.join(REPO, "lib", "route.js")).href);
    const routes = [];
    const scope = {
      effect(fn) {
        fn();
        return () => {};
      },
      webServer: {
        register(r) {
          routes.push(r);
          return () => {};
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    };
    routeMod.registerSettingsRoute(scope);
    checker.check("registerSettingsRoute 注册了 1 条路由", () => {
      assert.equal(routes.length, 1, `实际 ${routes.length} 条`);
      route = routes[0];
    });
  } catch (e) {
    console.log(`  ${C.red("FAIL")} 路由加载失败：${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }

  checker.check("路由元信息正确（path/kind/handler）", () => {
    assert.ok(route, "没有拿到路由");
    assert.equal(route.path, "/yuanbao-t2i/config");
    assert.ok(route.kind === "exact" || route.kind === undefined, `kind = ${route.kind}`);
    assert.equal(typeof route.handler, "function");
  });

  checker.check("SETTINGS_PATH 已被重定向到临时目录（不碰真实用户配置）", () => {
    assert.ok(SETTINGS_PATH, "SETTINGS_PATH 为空");
    assert.equal(path.resolve(SETTINGS_PATH), path.resolve(SETTINGS_FILE), `SETTINGS_PATH = ${SETTINGS_PATH}`);
    assert.ok(
      path.resolve(SETTINGS_PATH).startsWith(path.resolve(os.tmpdir())),
      `SETTINGS_PATH 不在临时目录内：${SETTINGS_PATH}`,
    );
  });

  // ── GET ────────────────────────────────────────────────────────────────────
  checker.step("GET /yuanbao-t2i/config");
  let getRes;
  await checker.acheck("GET → 200 且返回默认设置", async () => {
    getRes = await callRoute(route, "GET");
    assert.equal(getRes.status, 200, `status = ${getRes.status}, body = ${getRes.body}`);
    assert.ok(getRes.json, `响应不是 JSON：${getRes.body}`);
    assert.equal(getRes.json.wmEngine, "lama");
    assert.equal(getRes.json.wmMask, "tight");
    assert.equal(getRes.json.removeWatermark, false);
    assert.equal(getRes.json.path, SETTINGS_FILE);
  });

  // ── POST（非法引擎须被 sanitize 回落）────────────────────────────────────────
  checker.step('POST /yuanbao-t2i/config  { wmEngine: "telea" }');
  await checker.acheck("POST → 200 且 wmEngine 被回落为 lama", async () => {
    const r = await callRoute(route, "POST", { wmEngine: "telea", wmMask: "rect" });
    assert.equal(r.status, 200, `status = ${r.status}, body = ${r.body}`);
    assert.ok(r.json, `响应不是 JSON：${r.body}`);
    assert.equal(r.json.wmEngine, "lama", `回落失败：${JSON.stringify(r.json)}`);
    assert.equal(r.json.wmMask, "rect", "合法字段 wmMask 应被保留");
  });

  checker.check("落盘文件里 wmEngine 也是 lama（telea 未被写进磁盘）", () => {
    assert.ok(fs.existsSync(SETTINGS_FILE), `配置未落盘：${SETTINGS_FILE}`);
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    assert.equal(saved.wmEngine, "lama", `落盘内容 = ${JSON.stringify(saved)}`);
    assert.equal(saved.wmMask, "rect");
  });

  // ── DELETE ─────────────────────────────────────────────────────────────────
  checker.step("DELETE /yuanbao-t2i/config");
  await checker.acheck("DELETE → 405", async () => {
    const r = await callRoute(route, "DELETE");
    assert.equal(r.status, 405, `status = ${r.status}, body = ${r.body}`);
  });

  // ── 真实用户配置未被污染 ────────────────────────────────────────────────────
  checker.check("真实用户配置未被改动", () => {
    const realAfter = statSafe(REAL_SETTINGS_FILE);
    if (!realBefore && !realAfter) return; // 本机本来就没有这个文件
    assert.deepEqual(realAfter, realBefore, `真实配置文件被改动了：${REAL_SETTINGS_FILE}`);
  });

  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }

  process.exit(checker.finish());
})().catch((e) => {
  console.error(`${C.red("FAIL")} 探针自身崩溃：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
