#!/usr/bin/env node
"use strict";
// CI · 工具注册探针（不联网 / 不需要 GPU / 不启动浏览器）
//
// 验证 lib/plugin.js 的 `apply(ctx, config)` 契约：
//   - 注册了 2 个工具：yuanbao_t2i / yuanbao_t2i_styles
//   - yuanbao_t2i 的参数（注册对象上的字段名是 `t.parameters`，不是 `t.schema`）里含
//     prompt / style / refImages / dstIntent / imageRatio / imageResolution / imageModel /
//     outDir / removeWatermark / wmEngine / wmMask
//   - wmEngine 的 enum 只含 lama
//   - 每个工具都有 output.schema（对象）且 output.render 是函数
//   - timeoutMs 是正有限数
//
// ⚠️ lib/plugin.js → lib/generate.js 顶层 `import { chromium } from "patchright"`。
//    真实 patchright 装得上时用真的；装不上时用 loader 钩子顶一个只会抛错的桩件，
//    保证「没装依赖也能断言工具契约」，且绝不联网、绝不启动浏览器。
//
// 退出码：0 = 全过；非 0 = 有断言失败。

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createChecker, C } = require("./helpers.cjs");

const REPO = path.resolve(__dirname, "..", "..");
const checker = createChecker("工具注册探针");

const REQUIRED_PARAMS = [
  "prompt",
  "style",
  "refImages",
  "dstIntent",
  "imageRatio",
  "imageResolution",
  "imageModel",
  "outDir",
  "removeWatermark",
  "wmEngine",
  "wmMask",
];

async function loadPluginModule() {
  let mode = "real";
  try {
    await import("patchright");
  } catch (e) {
    mode = "stub";
    checker.note(`真实 patchright 不可用（${e.code || e.message}）→ 改用 CI 桩件（不会启动浏览器）`);
    const { register } = require("node:module");
    register(pathToFileURL(path.join(__dirname, "loader-hooks.mjs")).href);
  }
  const mod = await import(pathToFileURL(path.join(REPO, "lib", "plugin.js")).href);
  return { mod, mode };
}

function makeCtx() {
  const collected = [];
  const routes = [];
  const logs = [];

  const logger = {
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(`[warn] ${String(m)}`),
    error: (m) => logs.push(`[error] ${String(m)}`),
  };

  // 插件在 ctx.inject(["webServer"], scope => ...) 里拿到的 scope：
  // route.js 需要 scope.effect + scope.webServer.register。
  const scope = {
    logger,
    effect(fn) {
      fn();
      return () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };

  const ctx = {
    logger,
    tools: {
      register(tool) {
        collected.push(tool);
      },
    },
    inject(deps, fn) {
      fn(scope);
    },
    effect: scope.effect,
    webServer: scope.webServer,
  };

  return { ctx, collected, routes, logs };
}

(async () => {
  checker.step("加载 lib/plugin.js");
  let mod;
  let mode;
  try {
    ({ mod, mode } = await loadPluginModule());
    console.log(`  ${C.green("ok  ")} 模块加载成功（patchright: ${mode}）`);
  } catch (e) {
    console.log(`  ${C.red("FAIL")} 模块加载失败：${e && e.stack ? e.stack : e}`);
    console.log(checker.finish() ? "" : "");
    process.exit(1);
  }

  checker.step("调用 apply(ctx, config)");
  const { ctx, collected, routes, logs } = makeCtx();
  try {
    mod.apply(ctx, { profileDir: path.join(REPO, ".ci-tmp", "profile"), outDir: path.join(REPO, ".ci-tmp", "out") });
    console.log(`  ${C.green("ok  ")} apply() 未抛异常`);
  } catch (e) {
    console.log(`  ${C.red("FAIL")} apply() 抛异常：${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
  if (logs.length) {
    for (const l of logs) console.log(`  ${C.dim("log ")} ${l}`);
  }

  checker.step("断言工具注册契约");
  checker.check("注册了 2 个工具", () => {
    assert.equal(collected.length, 2, `实际注册 ${collected.length} 个：${collected.map((t) => t.name).join(",")}`);
  });

  const byName = new Map(collected.map((t) => [t.name, t]));

  checker.check("工具名为 yuanbao_t2i 与 yuanbao_t2i_styles", () => {
    assert.ok(byName.has("yuanbao_t2i"), "缺少 yuanbao_t2i");
    assert.ok(byName.has("yuanbao_t2i_styles"), "缺少 yuanbao_t2i_styles");
  });

  const t2i = byName.get("yuanbao_t2i");
  const styles = byName.get("yuanbao_t2i_styles");

  checker.check("yuanbao_t2i.parameters 存在（字段名是 parameters，不是 schema）", () => {
    assert.ok(t2i, "没有 yuanbao_t2i");
    assert.ok(t2i.parameters && typeof t2i.parameters === "object", "parameters 缺失");
    assert.equal(t2i.parameters.type, "object", "parameters.type 应为 object");
  });

  checker.check("yuanbao_t2i 参数齐全：" + REQUIRED_PARAMS.join(", "), () => {
    const props = (t2i.parameters && t2i.parameters.properties) || {};
    const missing = REQUIRED_PARAMS.filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
    assert.equal(missing.length, 0, `缺少参数：${missing.join(", ")}`);
  });

  checker.check("yuanbao_t2i.required 含 prompt", () => {
    const req = t2i.parameters.required || [];
    assert.ok(req.includes("prompt"), `required = ${JSON.stringify(req)}`);
  });

  checker.check("wmEngine 的 enum 只含 lama", () => {
    const props = t2i.parameters.properties || {};
    assert.ok(props.wmEngine, "缺少 wmEngine 参数");
    assert.deepEqual(props.wmEngine.enum, ["lama"], `enum = ${JSON.stringify(props.wmEngine.enum)}`);
  });

  checker.check("每个工具都有 output.schema（对象）与 output.render（函数）", () => {
    for (const t of collected) {
      assert.ok(t.output, `${t.name}: 缺少 output`);
      assert.ok(t.output.schema && typeof t.output.schema === "object", `${t.name}: 缺少 output.schema`);
      assert.equal(typeof t.output.render, "function", `${t.name}: output.render 不是函数`);
    }
  });

  checker.check("每个工具的 timeoutMs 都是正有限数", () => {
    for (const t of collected) {
      assert.equal(typeof t.timeoutMs, "number", `${t.name}: timeoutMs 不是数字`);
      assert.ok(Number.isFinite(t.timeoutMs), `${t.name}: timeoutMs 非有限数`);
      assert.ok(t.timeoutMs > 0, `${t.name}: timeoutMs 非正数`);
    }
  });

  checker.check("每个工具都有 description 与 execute", () => {
    for (const t of collected) {
      assert.equal(typeof t.description, "string", `${t.name}: description 不是字符串`);
      assert.ok(t.description.trim().length > 0, `${t.name}: description 为空`);
      assert.equal(typeof t.execute, "function", `${t.name}: execute 不是函数`);
    }
  });

  checker.check("yuanbao_t2i_styles.parameters 存在且有 keyword/limit", () => {
    assert.ok(styles, "没有 yuanbao_t2i_styles");
    assert.ok(styles.parameters, "yuanbao_t2i_styles 缺少 parameters");
    const props = styles.parameters.properties || {};
    assert.ok(Object.prototype.hasOwnProperty.call(props, "keyword"), "缺少 keyword");
    assert.ok(Object.prototype.hasOwnProperty.call(props, "limit"), "缺少 limit");
  });

  checker.check("ctx.inject 生效：设置路由已注册（1 条 /yuanbao-t2i/config）", () => {
    assert.equal(routes.length, 1, `实际注册 ${routes.length} 条路由`);
    assert.equal(routes[0].path, "/yuanbao-t2i/config");
    assert.equal(typeof routes[0].handler, "function");
  });

  process.exit(checker.finish());
})().catch((e) => {
  console.error(`${C.red("FAIL")} 探针自身崩溃：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
