// dsh-yuanbao-t2i · 核心生成器（与 cordis 解耦，可独立测试）
// 走 yuanbao.tencent.com 的 /api/chat SSE，从 type=replace 的 multimedias 取图，裸 fetch 落盘。
// 支持文生图（Text2Image）和图生图（Image2Image）。
//
// 图生图实现（2026-10-20 实测定型）：**不做任何签名**——用元宝前端自己的上传通道。
//   点「添加」→ 点「上传图片」→ 前端弹出 input[type=file] → setInputFiles 灌入参考图
//   → 前端自己走 genUploadInfo + COS PUT + asyncFileParse，生成缩略图与 multimedia 元数据
//   → 我们填提示词发送，前端自动把 multimedia[] 填进 /api/chat/ 请求体。
// 曾试过自己实现 COS 上传（genUploadInfo + HMAC-SHA1 签名 + TIMImageElem）：
//   ❌ 失败——元宝的 genUploadInfo 不认 X-Token/X-ID（那套来自 hermes-agent 的旧协议），
//      实际要 x-hy92/x-hy93/x-id + 前端侧签名，逆无可逆 ⇒ 放弃自研上传，改走前端通道。
import { chromium } from "patchright";
import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { ensureTemplates, matchTemplate, suggestTemplates, applyStyle } from "./templates.js";

export const YUANBAO_HOME = "https://yuanbao.tencent.com/chat/naQivTmsDa?chatMode=temp";
const LOGIN_PANEL_TEXT = "请使用微信扫描二维码登录";
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const MAX_REF_IMAGES = 5;

function extFromResponse(res) {
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  return "png";
}

// 抓取 /api/chat/ 的 event-stream 响应，抽出全部图片 URL（含重复，去重后返回）
// excludePaths：参考图自身的 COS 路径指纹（图生图时 SSE 会回显参考图，需剔除）
// 返回 { imgs, error }：error 为元宝下发的错误帧（type:"error"，含 code/msg），
//   例如 21003「当前对话已达到对话次数上限」——必须立刻抛给调用方，不能当"无图"干等超时。
function collectImagesFromSse(bodyText, excludePaths = []) {
  const seen = [];
  let error = null;
  for (const raw of bodyText.split("\n")) {
    const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
    if (!line || !line.startsWith("{")) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type === "error") {
      error = { code: obj.code || "", msg: obj.msg || obj?.error?.message || "元宝返回未知错误" };
      continue;
    }
    const rep = obj?.replace || obj?.data?.replace;
    const multimedias = rep?.multimedias;
    if (!Array.isArray(multimedias)) continue;
    for (const m of multimedias) {
      if (!m || m.mediaType !== "image") continue;
      const url = m.url || m.downloadUrl || m.previewUrl || m.originUrl;
      if (!url) continue;
      // 参考图回显：上传目录是 /multimedia_xx/，生成结果在 /text2img/ 下
      if (url.includes("/multimedia_")) continue;
      if (excludePaths.length && excludePaths.some((p) => url.includes(p))) continue;
      if (!seen.includes(url)) seen.push(url);
    }
  }
  return { imgs: seen, error };
}

// ── 图生图：参考图解析 ────────────────────────────────────────────────
// 支持：本地图片文件 / 文件夹（自动遍历图片）/ http(s) URL（先下载到临时目录）
async function resolveRefImages(paths, log) {
  const out = [];
  for (const p of paths) {
    if (out.length >= MAX_REF_IMAGES) break;
    if (/^https?:\/\//i.test(p)) {
      const file = await downloadToTemp(p, log);
      if (file) out.push(file);
      continue;
    }
    const st = await stat(p).catch(() => null);
    if (!st) { log(`  跳过不存在的路径：${p}`); continue; }
    if (st.isDirectory()) {
      const names = await readdir(p).catch(() => []);
      const imgs = names
        .filter((n) => IMAGE_EXTS.has(extname(n).toLowerCase()))
        .map((n) => join(p, n));
      const room = MAX_REF_IMAGES - out.length;
      out.push(...imgs.slice(0, room));
      log(`  文件夹 ${p} → 命中 ${imgs.length} 张图片（取前 ${Math.min(room, imgs.length)} 张）`);
    } else if (IMAGE_EXTS.has(extname(p).toLowerCase())) {
      out.push(p);
    } else {
      log(`  跳过非图片文件：${p}`);
    }
  }
  return out;
}

async function downloadToTemp(url, log) {
  try {
    const r = await fetch(url);
    if (!r.ok) { log(`  参考图 URL 下载失败 HTTP ${r.status}：${url.slice(0, 80)}`); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const ext = ct.includes("png") ? ".png" : ct.includes("jpeg") || ct.includes("jpg") ? ".jpg"
      : ct.includes("webp") ? ".webp" : extname(new URL(url).pathname).toLowerCase() || ".png";
    const file = join(tmpdir(), `yuanbao-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await writeFile(file, buf);
    log(`  参考图 URL 已下载：${(buf.length / 1024).toFixed(0)}KB -> ${file}`);
    return file;
  } catch (e) {
    log(`  参考图 URL 下载失败：${e.message}`);
    return null;
  }
}

// ── 图生图：走元宝前端原生上传通道 ────────────────────────────────────
// 真实链路（2026-10-20 抓包）：点「添加」→ 点「上传图片」→ 前端动态创建
//   input[type=file] 并 click() → 前端 POST /api/resource/genUploadInfo → COS PUT
//   → /api/resource/asyncFileParse → 编辑器内出现 cos 缩略图 → 发送时
//   /api/chat/ 的 multimedia[] 自动带上。
//
// 🔴 必须【先注册 filechooser 监听再点「上传图片」】：
//   前端那一步是真实的 input.click()，浏览器会弹出 Windows 原生「打开」文件对话框；
//   patchright 只有在存在 filechooser 监听器时才会下发
//   Page.setInterceptFileChooserDialog（见 patchright-core/lib/coreBundle.js 的
//   fileChooserIntercepted()），没监听 ⇒ 不拦截 ⇒ 系统文件框弹出后没人关，
//   会一直挂在用户桌面上（2026-10-21 主人反馈：「你每次上传图片都会打开一个这个
//   界面，然后你不关掉吗，很影响我」）。
//   ⇒ 监听器必须在点菜单【之前】注册，用 chooser.setFiles() 灌文件；
//      不再用 locator.setInputFiles（那是 CDP 直灌，关不掉已弹出的原生框）。
async function attachReferenceImages(page, files, log) {
  log(`上传 ${files.length} 张参考图（走元宝前端原生上传通道）…`);

  // 先挂 filechooser 拦截（必须在点击之前注册）
  let chooser = null;
  const onChooser = (fc) => {
    if (!chooser) chooser = fc;
  };
  page.on("filechooser", onChooser);

  try {
    const addBtn = page.locator('button[aria-label="添加"]').first();
    await addBtn.waitFor({ state: "visible", timeout: 20000 });
    await addBtn.click({ timeout: 8000 });

    const upItem = page.locator("text=上传图片").first();
    await upItem.waitFor({ state: "visible", timeout: 10000 });
    await upItem.click({ timeout: 8000 });

    // 等 filechooser 事件（被拦截，不会弹系统文件框）
    const waitUntil = Date.now() + 20000;
    while (!chooser && Date.now() < waitUntil) await page.waitForTimeout(200);
    if (!chooser) throw new Error("未捕获到文件选择器（filechooser），参考图无法注入");
    log("  已拦截文件选择器（不会弹出系统文件框）");

    await chooser.setFiles(files);
    log("  已把文件交给前端，等待上传完成…");

    // 前端上传完成后，编辑器区会出现 cos 缩略图（src 含 multimedia_）
    const deadline = Date.now() + 180000;
    let previews = 0;
    while (Date.now() < deadline) {
      previews = await page.locator('img[src*="multimedia_"]').count().catch(() => 0);
      if (previews >= files.length) break;
      await page.waitForTimeout(1000);
    }
    if (previews < files.length) {
      throw new Error(`参考图上传未完成（${previews}/${files.length} 张出现预览），请检查网络或登录态`);
    }
    log(`  上传完成，编辑器内出现 ${previews} 张预览`);

    // 记下参考图自身的 COS 路径（发送后 SSE 里可能回显参考图，需从结果中剔除）
    const srcs = await page.$$eval('img[src*="multimedia_"]', (els) => els.map((e) => e.getAttribute("src") || ""));
    const refPaths = srcs
      .map((s) => { try { return new URL(s).pathname; } catch { return ""; } })
      .filter(Boolean);
    if (refPaths.length) log(`  参考图路径指纹 ${refPaths.length} 条（用于剔除回显）`);

    // 关掉可能仍开着的上传浮层，避免遮挡输入框
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
    return refPaths;
  } finally {
    page.off("filechooser", onChooser);
  }
}

// ── 元宝「AI 生图」模式的真实比例 / 分辨率 / 模型控件 ──────────────────
// 2026-10-21 抓包结论（推翻此前「元宝没有比例控件」的错误结论）：
//   比例控件【必须先切「AI 生图」模式】才渲染（静态扫 DOM 零命中是假阴性）。
//   切模式后 composer 上方出现三个选择器：比例 / 分辨率 / 切换模型。
//   选了之后，请求体才会带上 extra.image_gen_param = {model, ratio, resolution}：
//     文生图（msgScene 13）：ratio 16:9 → 出图 2240x1248；不切模式 → 出图 1344x1792（默认 3:4）
//     图生图（msgScene 12）：【必须先传参考图再切模式】，否则 extra 整个不出现
//   ⇒ 顺序很重要：先上传参考图 → 再切「AI 生图」→ 再设比例 → 发送。
//   切模式不会清掉已上传的参考图（预览数不变，实测 1 → 1）。
// 菜单项类名带 CSS Module 哈希，不稳定 ⇒ 只能用 [class*="ai-creation_optionMenuItem"]
//   + :text-is() 精确文本匹配（getByRole(name, exact) 实测匹配不到）。
const AI_CHIP = 'button[aria-label="AI 生图"]';
const OPTION_ITEM = '[class*="ai-creation_optionMenuItem"]';

async function applyImageGenParams(page, { ratio, resolution, model }, log) {
  if (!ratio && !resolution && !model) {
    log("未指定比例/分辨率/模型 → 走默认对话生图路径（输出比例由元宝服务端决定）");
    return { applied: false };
  }
  // 比例控件存在即说明已在「AI 生图」模式
  const ratioBtn = page.locator('[aria-label="比例"]').first();
  if ((await ratioBtn.count().catch(() => 0)) === 0) {
    const chip = page.locator(AI_CHIP).first();
    await chip.waitFor({ state: "visible", timeout: 20000 });
    await chip.click({ timeout: 10000 });
    await ratioBtn.waitFor({ state: "visible", timeout: 25000 });
    log("已切到「AI 生图」模式（比例/分辨率控件已出现）");
  }

  const pick = async (ariaLabel, value) => {
    const btn = page.locator(`[aria-label="${ariaLabel}"]`).first();
    await btn.click({ timeout: 10000 });
    const item = page.locator(`${OPTION_ITEM}:text-is("${value}")`).first();
    await item.waitFor({ state: "visible", timeout: 10000 });
    await item.click({ timeout: 10000 });
    await page.waitForTimeout(600);
    const cur = (await btn.textContent().catch(() => "")) || "";
    log(`  ${ariaLabel} = ${cur.trim() || value}`);
  };

  if (ratio) await pick("比例", ratio);
  if (resolution) await pick("分辨率", resolution);
  if (model) await pick("切换模型", model);
  return { applied: true };
}

export async function generate({
  prompt,
  refImages = [],
  dstIntent,
  imageRatio = "16:9",
  imageRatioExplicit = false,
  imageResolution = "",
  imageModel = "",
  seed,
  style = "",
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

    // 图生图：把参考图交给元宝前端原生上传通道
    const refFiles = [];
    if (refImages.length > 0) {
      const resolved = await resolveRefImages(refImages, log);
      if (!resolved.length) throw new Error("refImages 中没有有效图片文件");
      refFiles.push(...resolved);
    }
    let refPaths = [];

    // ── 画风预设（style）：从元宝官方模板库里挑一条画风模板，套到提示词上 ──
    // 模板库是元宝 AI 创作页那 1000+ 条模板（协议见 lib/templates.js）。
    // 这里只在「本次要套模板」时才去拉（首次会落盘缓存，之后走本地缓存）。
    let styleInfo = null;
    let effectivePrompt = prompt;
    let styleRatio = "";
    if (style && String(style).trim()) {
      const tpls = await ensureTemplates({ page, log });
      const tpl = matchTemplate(tpls, String(style).trim());
      if (!tpl) {
        const sug = suggestTemplates(tpls, String(style).trim());
        throw new Error(
          `模板库里没有画风模板「${style}」${sug.length ? `。相近的有：${sug.join("、")}` : ""}。` +
            `可先用 yuanbao_t2i_styles 列一下有哪些画风。`,
        );
      }
      const applied = applyStyle(tpl, prompt, imageRatioExplicit ? imageRatio : "", refFiles.length > 0);
      effectivePrompt = applied.prompt;
      styleRatio = applied.ratio;
      styleInfo = {
        name: tpl.name,
        tab: tpl.tab,
        id: tpl.id,
        genType: tpl.gen_type,
        ratio: applied.ratio,
        ratioSource: applied.ratioSource,
        needsRef: applied.needsRef,
        notes: applied.notes,
      };
      for (const n of applied.notes) log(`  ${n}`);
      if (applied.needsRef && !refFiles.length) {
        log(`  注意：画风模板「${tpl.name}」本属图生图（需参考图），本次按纯文生图套用风格描述`);
      }
    }

    // 先挂 SSE 监听，再点发送（防响应早于监听）
    const pending = [];
    let waiter = null;
    let failer = null;
    page.on("response", (res) => {
      const url = res.url();
      if (!/\/api\/chat\//.test(url)) return;
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("text/event-stream")) return;
      const p = (async () => {
        let body = "";
        try {
          const buf = await res.body();
          // 必须自己按 UTF-8 解码：event-stream 响应头没有 charset，
          // res.text() 会按 latin-1 解，中文错误消息会变成乱码。
          body = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
        } catch {
          body = await res.text().catch(() => "");
        }
        const { imgs, error } = collectImagesFromSse(body, refPaths);
        if (error) {
          log(`元宝返回错误：${error.code} ${error.msg}`);
          if (failer) failer(new Error(`元宝返回错误 ${error.code ? `[${error.code}] ` : ""}${error.msg}`));
          return;
        }
        log(`收到 SSE：${imgs.length} 张图`);
        if (!imgs.length) return; // 无图的 SSE 忽略，继续等
        if (waiter) waiter(imgs);
        else pending.push(imgs);
      })().catch((e) => log(`SSE 读取失败：${e.message}`));
      p.catch(() => {});
    });

    // 比例：2026-10-21 起是真生效（走「AI 生图」模式的比例控件），
    // 不再往提示词里塞比例词。旧值 "ref:1" 保留为「智能比例」别名
    // （元宝菜单原文「智能比例」＝服务端自动挑比例，图生图时贴近参考图）。
    const RATIO_ALIAS = { "ref:1": "智能比例" };
    // 比例优先级：用户显式传 > 画风模板自带 > 插件默认（16:9）
    const ratioRaw = imageRatioExplicit ? imageRatio : (styleRatio || imageRatio);
    const ratioValue = ratioRaw ? (RATIO_ALIAS[ratioRaw] || ratioRaw) : "";
    if (styleInfo) {
      styleInfo.ratioUsed = ratioValue;
      styleInfo.ratioSource = imageRatioExplicit ? "用户指定" : (styleRatio ? "模板自带" : "插件默认");
    }

    // 临时会话（chatMode=temp）累积轮次后会返回 code 21003
    // 「当前对话已达到对话次数上限」。自愈策略：新建对话后重试一轮。
    const MAX_ATTEMPTS = 2;
    let urls = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          log("上一轮撞到会话轮次上限，重试：新建对话后重发");
          await startFreshConversation(page, log);
          await page.waitForTimeout(1500);
          await dismissOverlays(page);
        }
        // 图生图：参考图交给元宝前端原生上传通道，
        // 发送时前端会自动把 multimedia[] 填进 /api/chat/ 请求体（无需我们构造）。
        if (refFiles.length) {
          refPaths = await attachReferenceImages(page, refFiles, log);
        }
        // ⚠️ 顺序：先传参考图，再切「AI 生图」模式并设比例/分辨率/模型。
        //   反了（先切模式再传图）⇒ 请求体里 extra.image_gen_param 整个不出现
        //   ⇒ 比例静默不生效（2026-10-21 实测）。
        await applyImageGenParams(
          page,
          { ratio: ratioValue, resolution: imageResolution, model: imageModel },
          log,
        );

        log(`填写提示词：${effectivePrompt.slice(0, 60)}`);
        const editor = page.locator(".ql-editor").first();
        await editor.waitFor({ state: "visible", timeout: 30000 });
        await editor.click();
        await editor.fill(effectivePrompt);

        const send = page.locator("#yuanbao-send-btn:not([class*='disabled'])");
        await send.waitFor({ state: "visible", timeout: 30000 });
        await send.click();
        log("已发送，等待生图…");

        pending.length = 0;
        urls = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`等待生图超时（${timeoutMs}ms）`)), timeoutMs);
          waiter = (imgs) => { clearTimeout(timer); resolve(imgs); };
          failer = (e) => { clearTimeout(timer); reject(e); };
          if (pending.length) { clearTimeout(timer); resolve(pending.shift()); }
        });
        break;
      } catch (e) {
        if (attempt < MAX_ATTEMPTS && /21003/.test(String(e && e.message))) {
          log(`元宝会话轮次达上限：${e.message}`);
          continue;
        }
        throw e;
      }
    }
    if (!urls) throw new Error("未取到生图结果");
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
    return { prompt, effectivePrompt, refImages, dstIntent, imageRatio, imageResolution, imageModel, seed, style: styleInfo, urls, files, count: files.length };
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

// 每次生成前先开一个新对话：同一个临时对话累积轮次后会返回
// code 21003「当前对话已达到对话次数上限」（实测 2026-10-20）。
// 实测：重新加载 chatMode=temp URL 会拿到新的 conversationId 且仍是临时对话
// （不落历史）；点页面上的「新建对话」则会跳到非临时会话（留历史），故不采用。
async function startFreshConversation(page, log) {
  try {
    await page.goto(YUANBAO_HOME, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);
    await dismissOverlays(page);
    log("已重新载入临时会话（拿到新的 conversationId）");
  } catch (e) {
    log(`新建会话失败（沿用当前会话）：${String(e && e.message).split("\n")[0]}`);
  }
}
