// ESM loader 钩子：把裸导入 "patchright" 重定向到 CI 桩件。
//
// 为什么需要它：lib/plugin.js → lib/generate.js 顶层 `import { chromium } from "patchright"`，
// 而 lib/generate.js 是真实联网生成路径（会启动浏览器），CI 绝不能跑它。
// 于是探针在「真实 patchright 装不上」时用本钩子兜底：模块图照常解析成功，
// 但拿到的是只会抛错的桩件 ⇒ 工具注册契约仍可被完整断言，且绝不联网。
//
// 仅在 probe-tools.cjs 里、且仅当真实 patchright 解析失败时注册。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "patchright") {
    return {
      url: new URL("./stub-patchright.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
