#!/usr/bin/env node
"use strict";
// CI · 打包完整性检查（不联网）
//
//  1) package.json 的 "files" 字段列出的每一项都真实存在
//     （少一个文件 ⇒ npm publish 出来的包缺件，用户装了才发现）。
//  2) "exports" 里声明的每个路径都真实存在。
//  3) "main" 指向的文件真实存在；"type" 等关键字段合法。
//
// 退出码：0 = 全过；非 0 = 有缺件。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createChecker, C } = require("./helpers.cjs");

const REPO = path.resolve(__dirname, "..", "..");
const checker = createChecker("打包完整性检查");

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
}

// exports 的值可能是字符串，也可能是 { import: ..., require: ... } 这种条件对象。
function exportTargets(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) exportTargets(v, out);
  }
  return out;
}

function main() {
  const pkg = readPkg();

  checker.check("package.json 可解析且有 name/version", () => {
    assert.equal(typeof pkg.name, "string");
    assert.ok(pkg.name.length > 0, "name 为空");
    assert.equal(typeof pkg.version, "string");
    assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version), `version 形似非法：${pkg.version}`);
  });

  checker.check("files 字段存在且非空", () => {
    assert.ok(Array.isArray(pkg.files), "files 不是数组");
    assert.ok(pkg.files.length > 0, "files 为空数组");
  });

  const files = Array.isArray(pkg.files) ? pkg.files : [];
  for (const entry of files) {
    checker.check(`files 条目存在：${entry}`, () => {
      const abs = path.join(REPO, entry);
      assert.ok(fs.existsSync(abs), `package.json.files 里的 "${entry}" 在仓库中不存在（npm 发包会缺件）`);
      assert.ok(fs.statSync(abs).isFile() || fs.statSync(abs).isDirectory(), `"${entry}" 既不是文件也不是目录`);
    });
  }

  checker.check("exports 字段存在", () => {
    assert.ok(pkg.exports && typeof pkg.exports === "object", "exports 缺失或不是对象");
  });

  const exportsMap = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {};
  for (const [key, value] of Object.entries(exportsMap)) {
    for (const target of exportTargets(value)) {
      checker.check(`exports 目标存在：${key} → ${target}`, () => {
        const abs = path.join(REPO, target);
        assert.ok(fs.existsSync(abs), `exports "${key}" 指向的 "${target}" 不存在`);
        assert.ok(fs.statSync(abs).isFile(), `"${target}" 不是文件`);
      });
    }
  }

  checker.check("main 指向的文件存在", () => {
    assert.equal(typeof pkg.main, "string", "main 缺失");
    const abs = path.join(REPO, pkg.main);
    assert.ok(fs.existsSync(abs), `main 指向的 "${pkg.main}" 不存在`);
  });

  // package-lock.json 的 root version 必须和 package.json 一致。
  // 2026-10-21 实测漂移：pkg 写在 0.8.1、lock 还停在 0.2.0（npm ci 不会报错，但版本语义已经错了）。
  checker.check("package-lock.json 版本与 package.json 一致", () => {
    const lockPath = path.join(REPO, "package-lock.json");
    assert.ok(fs.existsSync(lockPath), "package-lock.json 不存在");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const rootLocked = (lock.packages && lock.packages[""] && lock.packages[""]) || {};
    assert.equal(lock.version, pkg.version, `lock.version=${lock.version} ≠ package.json version=${pkg.version}`);
    if (rootLocked.version) {
      assert.equal(rootLocked.version, pkg.version, `lock.packages[""].version=${rootLocked.version} ≠ ${pkg.version}`);
    }
  });

  checker.check("type 为 module（插件是 ESM）", () => {
    assert.equal(pkg.type, "module");
  });

  checker.check("dsh.bundle.patch 指向的文件存在", () => {
    const p = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
    assert.equal(typeof p, "string", "dsh.bundle.patch 缺失");
    const abs = path.join(REPO, p);
    assert.ok(fs.existsSync(abs), `dsh.bundle.patch 指向的 "${p}" 不存在`);
  });

  // 关键入口文件必须落在 files 覆盖范围内（否则发包后插件起不来）
  checker.check("关键入口 lib/plugin.js / client.js 被 files 覆盖", () => {
    const covered = (rel) =>
      files.some((f) => {
        const norm = String(f).replace(/\\/g, "/").replace(/\/+$/, "");
        return rel === norm || rel.startsWith(norm + "/");
      });
    assert.ok(covered("lib/plugin.js"), "lib/plugin.js 未被 files 覆盖");
    assert.ok(covered("client.js"), "client.js 未被 files 覆盖");
  });

  console.log(`${C.dim("files:")} ${files.join(", ")}`);
  console.log(`${C.dim("exports:")} ${Object.keys(exportsMap).join(", ")}`);

  process.exit(checker.finish());
}

main();
