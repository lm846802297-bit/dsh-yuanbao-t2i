// CI 用的 patchright 桩件：只有在真实 patchright 装不上时才会被 loader 钩子顶上来。
// 只导出 generate.js 顶层 import 的那个符号，永远不会被真的调用（CI 不启动浏览器）。
export const chromium = {
  async launch() {
    throw new Error("CI 桩件：不允许在 CI 里启动浏览器（patchright 未安装时的兜底路径）");
  },
};
export default { chromium };
