// dsh-yuanbao-t2i · 核心生成器（与 cordis 解耦，可独立测试）
// 走 yuanbao.tencent.com 的 /api/chat SSE，从 type=replace 的 multimedias 取图，裸 fetch 落盘。
// 支持文生图（Text2Image）和图生图（Image2Image，传 refImages 自动走 COS 上传 + TIMImageElem）。
import { chromium } from "patchright";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { createHmac, createHash } from "node:crypto";

export const YUANBAO_HOME = "https://yuanbao.tencent.com/chat/naQivTmsDa?chatMode=temp";
const LOGIN_PANEL_TEXT = "请使用微信扫描二维码登录";
const UPLOAD_INFO_PATH = "/api/resource/genUploadInfo";
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

// MIME 映射（TIM 协议 image_format 字段）
const MIME_TO_IMAGE_FORMAT = {
  "image/jpeg": 1, "image/jpg": 1, "image/gif": 2, "image/png": 3,
  "image/bmp": 4, "image/webp": 255, "image/heic": 255, "image/tiff": 255,
};

function guessMime(filename) {
  const ext = extname(filename).toLowerCase();
  const map = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  };
  return map[ext] || "application/octet-stream";
}

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
  for (const raw of bodyText.split("\\n")) {
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

// HMAC-SHA1 签名（COS Authorization 头，参照腾讯云文档）
function cosSign({ method, path, headers, secretId, secretKey, startTime, expireSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const start = startTime || now;
  const qSignTime = `${start};${start + expireSeconds}`;
  const signKey = createHmac("sha1", secretKey).update(qSignTime).digest("hex");

  const sortedParams = []; // PUT 不带 query
  const sortedHeaders = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), encodeURIComponent(v)])
    .sort((a, b) => a[0].localeCompare(b[0]));

  const kv = (pairs) => pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const httpString = [method.toLowerCase(), path, kv(sortedParams), kv(sortedHeaders), ""].join("\\n");
  const stringToSign = ["sha1", qSignTime, createHash("sha1").update(httpString).digest("hex"), ""].join("\\n");
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");

  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${qSignTime}&q-key-time=${qSignTime}` +
    `&q-header-list=${sortedHeaders.map(([k]) => k).join(";")}&q-url-param-list=${kv(sortedParams)}` +
    `&q-signature=${signature}`;
}

// 上传单个参考图到元宝 COS（genUploadInfo → HMAC-SHA1 → PUT）
async function uploadToCos({ filePath, cookies, log }) {
  const buf = await readFile(filePath);
  const filename = basename(filePath);
  const mime = guessMime(filename);
  const fileId = createHash("md5").update(buf).digest("hex");

  // 1. 获取 COS 临时凭证
  const token = cookies.find((c) => c.name === "token" || c.name === "X-Token")?.value || "";
  const id = cookies.find((c) => c.name === "X-ID" || c.name === "uid")?.value || "";
  const genRes = await fetch(`https://yuanbao.tencent.com${UPLOAD_INFO_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Token": token,
      "X-ID": id,
      "X-Source": "web",
    },
    body: JSON.stringify({ fileName: filename, fileId, docFrom: "localDoc", docOpenId: "" }),
  });
  const genData = await genRes.json();
  if (genData.code !== 0 && genData.code !== undefined) {
    throw new Error(`genUploadInfo 失败：code=${genData.code} msg=${genData.msg || ""}`);
  }
  const cred = genData.data || genData;
  const { bucketName, location, encryptTmpSecretId, encryptTmpSecretKey, encryptToken, startTime, expiredTime, resourceUrl } = cred;
  if (!bucketName || !location) throw new Error("genUploadInfo 返回字段不完整");

  // 2. HMAC-SHA1 签名上传到 COS
  const cosHost = `${bucketName}.cos.accelerate.myqcloud.com`;
  const encodedKey = location.replace(/^\//, "");
  const cosUrl = `https://${cosHost}/${encodedKey}`;
  const now = Math.floor(Date.now() / 1000);
  const authorization = cosSign({
    method: "put",
    path: `/${encodedKey}`,
    headers: { host: cosHost, "content-type": mime, "x-cos-security-token": encryptToken },
    secretId: encryptTmpSecretId,
    secretKey: encryptTmpSecretKey,
    startTime: startTime || now,
    expireSeconds: expiredTime && expiredTime > now ? expiredTime - now : 3600,
  });

  const putRes = await fetch(cosUrl, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": mime,
      "x-cos-security-token": encryptToken,
    },
    body: buf,
  });
  if (!putRes.ok) throw new Error(`COS PUT 失败 HTTP ${putRes.status}`);

  const uuid = createHash("md5").update(buf).digest("hex");
  const result = { url: resourceUrl || cosUrl, uuid, size: buf.length, mime };
  log(`  已上传参考图：${filename} (${(buf.length / 1024 / 1024).toFixed(2)}MB) -> ${result.url.slice(0, 60)}...`);
  return result;
}

// 构建 TIMImageElem 消息体（图生图用）
function buildImageMsgBody({ url, uuid, size, mime, width = 0, height = 0 }) {
  return [{
    msg_type: "TIMImageElem",
    msg_content: {
      uuid: uuid || "image",
      image_format: MIME_TO_IMAGE_FORMAT[mime] || 255,
      image_info_array: [{ type: 1, size, width, height, url }],
    },
  }];
}

export async function generate({
  prompt,
  refImages = [],
  dstIntent,
  imageRatio = "16:9",
  seed,
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

    // 图生图：上传参考图到 COS
    const uploadedImages = [];
    if (refImages.length > 0) {
      log(`上传 ${refImages.length} 张参考图到 COS…`);
      const cookies = await ctx.cookies();
      for (const refPath of refImages.slice(0, 5)) {
        const st = await stat(refPath).catch(() => null);
        if (st && st.isFile() && IMAGE_EXTS.has(extname(refPath).toLowerCase())) {
          const up = await uploadToCos({ filePath: refPath, cookies, log });
          uploadedImages.push(up);
        } else {
          log(`  跳过非图片文件：${refPath}`);
        }
      }
      if (uploadedImages.length === 0) throw new Error("refImages 中没有有效图片文件");
    }

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

    // 图生图：把参考图以 TIMImageElem 形式发出去
    if (uploadedImages.length > 0) {
      log("发送图生图消息（含参考图）…");
      const imgMsgBodies = uploadedImages.map((up) => buildImageMsgBody(up));
      // 注入到页面：把 TIMImageElem 列表挂到 window，由前端读取后与 prompt 一起发
      await page.evaluate((imgBodies) => {
        window.__YUANBAO_PENDING_IMAGES__ = imgBodies;
      }, imgMsgBodies);
    }

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
    return { prompt, refImages, dstIntent, imageRatio, seed, urls, files, count: files.length };
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
