#!/usr/bin/env node
"use strict";
// CI · 路由探针（不联网 / 不启动浏览器 / 不碰真实用户配置）
//
// 打 lib/route.js 注册的 /yuanbao-t2i/config 路由：
//   GET    → 200（配置里预置了旧版才有的 wmMask ⇒ 须被**静默忽略**，其余字段照常生效）
//   POST {wmEngine:"telea", wmMask:"tight"} → 200，且落盘后被 sanitize 回落为 "lama"
//        （telea 已下架）；已撤下的 wmMask 被丢弃、不回写（v0.10.0 起掩膜改内部自适应）
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

  // ── 预置「旧版配置文件」──────────────────────────────────────────────────────
  // 旧版（≤v0.9.0）的配置里有 wmMask；v0.10.0 起该键已从设置面撤下 ⇒ 必须被**静默忽略**
  //（不报错、不迁移、不回写），配置里其余字段照常生效。这里先把旧文件写进去再走 GET/POST。
  const OLD_CONF = { removeWatermark: true, wmEngine: "lama", wmMask: "rect", outDir: "" };
  checker.check("预置旧版配置（含已撤下的 wmMask）", () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(OLD_CONF, null, 2) + "\n", "utf8");
    const back = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    assert.equal(back.wmMask, "rect", "预置失败：旧配置里本该有 wmMask");
  });

  // ── GET ────────────────────────────────────────────────────────────────────
  checker.step("GET /yuanbao-t2i/config");
  let getRes;
  await checker.acheck("GET → 200 且旧配置的 wmMask 被静默忽略、其余字段生效", async () => {
    getRes = await callRoute(route, "GET");
    assert.equal(getRes.status, 200, `status = ${getRes.status}, body = ${getRes.body}`);
    assert.ok(getRes.json, `响应不是 JSON：${getRes.body}`);
    assert.equal(getRes.json.wmEngine, "lama");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(getRes.json, "wmMask"),
      `wmMask 已撤下，不该出现在响应里：${JSON.stringify(getRes.json)}`,
    );
    assert.equal(getRes.json.removeWatermark, true, "旧配置里的其它字段应照常生效");
    assert.equal(getRes.json.path, SETTINGS_FILE);
  });

  // ── POST（非法引擎须被 sanitize 回落；已撤下的 wmMask 须被丢弃）────────────────
  checker.step('POST /yuanbao-t2i/config  { wmEngine: "telea", wmMask: "tight" }');
  await checker.acheck("POST → 200 且 wmEngine 被回落为 lama、wmMask 被丢弃", async () => {
    const r = await callRoute(route, "POST", { wmEngine: "telea", wmMask: "tight" });
    assert.equal(r.status, 200, `status = ${r.status}, body = ${r.body}`);
    assert.ok(r.json, `响应不是 JSON：${r.body}`);
    assert.equal(r.json.wmEngine, "lama", `回落失败：${JSON.stringify(r.json)}`);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(r.json, "wmMask"),
      `已撤下的 wmMask 即便被 POST 上来也必须被丢弃：${JSON.stringify(r.json)}`,
    );
  });

  checker.check("落盘文件里 wmEngine 也是 lama，且不含 wmMask", () => {
    assert.ok(fs.existsSync(SETTINGS_FILE), `配置未落盘：${SETTINGS_FILE}`);
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    assert.equal(saved.wmEngine, "lama", `落盘内容 = ${JSON.stringify(saved)}`);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(saved, "wmMask"),
      `落盘内容不该有 wmMask（旧键不回写）：${JSON.stringify(saved)}`,
    );
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
