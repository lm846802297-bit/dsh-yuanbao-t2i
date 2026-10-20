// dsh-yuanbao-t2i · 核心生成器（与 cordis 解耦，可独立测试）
// 走 yuanbao.tencent.com 的 /api/chat SSE，从 type=replace 的 multimedias 取图，裸 fetch 落盘。
import { chromium } from "patchright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const YUANBAO_HOME = "https://yuanbao.tencent.com/chat/naQivTmsDa?chatMode=temp";
const LOGIN_PANEL_TEXT = "请使用微信扫描二维码登录";

function extFromResponse(res) {
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  return "png";
}

// 抓取 /api/chat/ 的 event-stream 响应，抽出全部图片 URL（含重复，去重后返回）
function collectImagesFromSse(bodyText) {
  const seen = [];
  for (const raw of bodyText.split("\n")) {
    const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
    if (!line || !line.startsWith("{")) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const rep = obj?.replace || obj?.data?.replace;
    const multimedias = rep?.multimedias;
    if (!Array.isArray(multimedias)) continue;
    for (const m of multimedias) {
      if (!m || m.mediaType !== "image") continue;
      const url = m.url || m.downloadUrl || m.previewUrl || m.originUrl;
      if (url && !seen.includes(url)) seen.push(url);
    }
  }
  return seen;
}

export async function generate({
  prompt,
  profileDir,
  outDir,
  headless = false,
  timeoutMs = 180000,
  log = () => {},
}) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt 必须是非空字符串");
  if (!profileDir) throw new Error("profileDir 缺少（用于持久化登录态）");
  await mkdir(outDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1600, height: 950 },
    locale: "zh-CN",
    args: ["--start-maximized"],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(YUANBAO_HOME, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.bringToFront().catch(() => {});
    log("已打开元宝，检查登录态…");
    await page.locator(`text=${LOGIN_PANEL_TEXT}`).waitFor({ state: "hidden", timeout: 180000 }).catch(() => {
      throw new Error("登录态失效：未在 180 秒内完成微信扫码登录。请先手动登录一次以建立 profile。");
    });
    await page.waitForTimeout(1500);
    await dismissOverlays(page);

    // 先挂 SSE 监听，再点发送（防响应早于监听）
    const pending = [];
    let waiter = null;
    page.on("response", (res) => {
      const url = res.url();
      if (!/\/api\/chat\//.test(url)) return;
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("text/event-stream")) return;
      const p = res.text().then((body) => {
        const imgs = collectImagesFromSse(body);
        log(`收到 SSE：${imgs.length} 张图`);
        if (!imgs.length) return; // 无图的 SSE 忽略，继续等
        if (waiter) waiter(imgs);
        else pending.push(imgs);
      }).catch((e) => log(`SSE 读取失败：${e.message}`));
      p.catch(() => {});
    });

    log(`填写提示词：${prompt.slice(0, 60)}`);
    const editor = page.locator(".ql-editor").first();
    await editor.waitFor({ state: "visible", timeout: 30000 });
    await editor.click();
    await editor.fill(prompt);
    const send = page.locator("#yuanbao-send-btn:not([class*='disabled'])");
    await send.waitFor({ state: "visible", timeout: 30000 });
    await send.click();
    log("已发送，等待生图…");

    const urls = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待生图超时（${timeoutMs}ms）`)), timeoutMs);
      waiter = (imgs) => { clearTimeout(timer); resolve(imgs); };
      if (pending.length) { clearTimeout(timer); resolve(pending.shift()); }
    });
    if (!urls.length) throw new Error("SSE 中未找到任何图片 URL");

    log(`下载 ${urls.length} 张图…`);
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      const r = await fetch(urls[i]);
      if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}：${urls[i].slice(0, 120)}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const ext = (r.headers.get("content-type") || "").includes("jpeg") ? "jpg" : "png";
      const file = join(outDir, `yuanbao-${Date.now()}-${i}.${ext}`);
      await writeFile(file, buf);
      files.push(file);
      log(`  [${i + 1}/${urls.length}] ${(buf.length / 1024 / 1024).toFixed(2)}MB -> ${file}`);
    }
    return { prompt, urls, files, count: files.length };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function dismissOverlays(page) {
  const closers = page.locator('button[class*="guide-content_closeBtn"], button[aria-label="关闭"]');
  const n = await closers.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    await closers.nth(i).click({ timeout: 1500 }).catch(() => {});
  }
}
