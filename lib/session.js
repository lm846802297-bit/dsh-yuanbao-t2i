// lib/session.js —— 一次 launch、一个窗口连续出图（批量场景专用）
//
// 为什么要有这个文件（2026-10-22）：
//   主号连续批量图生图 45 张后被元宝冻结（页面「账号已冻结」）。复盘时主人指出
//   第一嫌疑是「每出一张图就关掉浏览器，下一张再开一个新窗口」——
//   短时间反复开关浏览器、反复重建登录态，在风控眼里非常像脚本。
//   ⇒ 批量一律走本模块：launch 一次（launchContext 是全仓唯一开浏览器的地方），
//     同一个 page 连续 generateOnPage（每张内部只重新载入临时会话拿新 conversationId，
//     不关窗口）。单张出图仍用 generate()。
import { launchContext, openPage, generateOnPage } from "./generate.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 建一个可复用会话（同一浏览器窗口）。
 * @returns {{page: object, count: number, closed: boolean, generate: Function, close: Function}}
 */
export async function openSession({ profileDir, headless = false, log = () => {} } = {}) {
  if (!profileDir) throw new Error("profileDir 缺少（用于持久化登录态）");
  const ctx = await launchContext(profileDir, { headless });
  const page = await openPage(ctx);
  let closed = false;
  let done = 0;
  log("已建立生图会话：本次只 launch 一次，所有图片在同一个窗口里连续生成");

  return {
    page,
    get count() {
      return done;
    },
    get closed() {
      return closed;
    },
    /** 在同一个窗口里生成一轮（参数同 generate()，outDir 必填）。 */
    async generate(args) {
      if (closed) throw new Error("session 已关闭");
      if (!args || typeof args !== "object") throw new Error("generate(args) 需要参数对象");
      const r = await generateOnPage(page, { log, ...args }, []);
      done += 1;
      return r;
    },
    async close() {
      if (closed) return;
      closed = true;
      await ctx.close().catch(() => {});
      log(`生图会话已关闭（本次窗口内共生成 ${done} 轮）`);
    },
  };
}

/**
 * 在一个会话里顺序跑多张（节流 + 连续失败刹车 + 可中断）。
 * @param session openSession() 的返回值
 * @param jobs 每项直接传给 session.generate()
 */
export async function generateMany(
  session,
  jobs,
  {
    gapMs = 90000,
    jitter = 0.33,
    maxConsecutiveFailures = 3,
    log = () => {},
    shouldStop = () => false,
    onResult = () => {},
  } = {},
) {
  if (!session) throw new Error("generateMany 需要 session");
  if (!Array.isArray(jobs)) throw new Error("jobs 必须是数组");
  const results = [];
  let consecutive = 0;

  for (let i = 0; i < jobs.length; i++) {
    if (shouldStop()) {
      log("收到停止信号，提前收尾");
      break;
    }
    if (session.closed) throw new Error("session 已关闭");
    const job = jobs[i] || {};
    const label = job.name || `第 ${i + 1} 张`;
    const t0 = Date.now();
    try {
      const r = await session.generate(job);
      consecutive = 0;
      const item = {
        ok: true,
        name: label,
        files: (r && r.files) || [],
        urls: (r && r.urls) || [],
        seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      };
      results.push(item);
      onResult(item);
      log(
        `[${i + 1}/${jobs.length}] ${label} OK ${item.seconds}s（${item.files.length} 张，累计 ${session.count} 轮）`,
      );
    } catch (e) {
      consecutive += 1;
      const item = {
        ok: false,
        name: label,
        error: String((e && e.message) || e).split("\n")[0],
        seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      };
      results.push(item);
      onResult(item);
      log(`[${i + 1}/${jobs.length}] ${label} FAIL ${item.seconds}s ${item.error}`);
      if (consecutive >= maxConsecutiveFailures) {
        log(`连续失败 ${consecutive} 次 ⇒ 立即刹车（不再试探，避免加重风控）`);
        break;
      }
    }
    if (i < jobs.length - 1 && gapMs > 0) {
      const wait = Math.round(gapMs * (1 - jitter + Math.random() * jitter * 2));
      await sleep(wait);
    }
  }
  return results;
}
