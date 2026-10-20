// dsh-yuanbao-t2i · 元宝官方模板库（画风预设）接入
//
// 元宝网页端有一整套「AI 创作」模板库，协议落点（2026-10-21 抓包）：
//   POST /api/v1/config/aigc/get-tab-list        { creation_type, jump_template_id, jump_tab_id, jump_sub_tab_id }
//   POST /api/v1/config/aigc/get-template-list    { index, limit, creation_type, tab_id, template_id, group_chat_id, version, filter_count }
// ⛔ body 必须带 creation_type（缺了会报 {"code":400,"message":"Invalid creation type"}）。
//   creation_type=2 → 文生图侧分类（全部/电商营销/海报设计/创意灵感/品牌设计/产品设计/UI设计/IP角色/电脑壁纸/智能P图/写实人像）
//   creation_type=3 → 图生图侧（tab_list 为空 ⇒ tab_id 传 "" 即可）
// 全量 ≈ 1882 条（ct2 1698 + ct3 184）；单条含完整 prompt。
//
// 模板分两类（决定插件怎么用）：
//   image2image（1498 条，占绝大多数）= 「画风/效果」模板，min_count=1（必须有参考图）。
//     prompt 形如「参考上传图生成图片：保持上传图比例不变，人物服饰、表情、动作不变；<画风描述>」
//     —— 正文后半段就是纯画风描述，正是本插件「style」参数要的东西。
//   text2image（384 条）= 「成品场景」模板（如电商海报），prompt 是整段场景说明，
//     当画风用会和用户自己的画面描述打架 ⇒ 本插件只接受 image2image 类做 style。
//
// 比例策略（模板 prompt 里 705 条内嵌「比例 3:4」这类词，而元宝自己的比例控件
// 在这些模板上是 disable_proportion=true ⇒ 两者会互相打架）：
//   ① 用户显式传 imageRatio → 以用户为准，并把模板正文里的比例词/「保持…比例不变」剥掉；
//   ② 用户没传 → 跟模板自己的比例走（正文里「比例 3:4」→ 控件设 3:4；
//      正文里「保持上传图比例不变」→ 控件设「智能比例」）；
//   ③ 模板也没写 → 用插件默认 16:9。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_PATH = join(homedir(), ".dsh", "yuanbao-t2i-templates.json");
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 模板库一周刷一次足够
const FETCH_LIMIT = 200;

// ── 本地缓存 ────────────────────────────────────────────────────────────
export async function loadTemplateCache() {
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const j = JSON.parse(raw);
    if (!Array.isArray(j.templates) || !j.templates.length) return null;
    return { templates: j.templates, fetchedAt: j.fetchedAt || 0 };
  } catch {
    return null;
  }
}

export async function saveTemplateCache(templates) {
  try {
    await mkdir(join(homedir(), ".dsh"), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), templates }), "utf8");
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

export function templateCachePath() {
  return CACHE_PATH;
}

// ── 抓取 ────────────────────────────────────────────────────────────────
async function fetchTemplatesInPage(page) {
  return await page.evaluate(async (limit) => {
    const post = async (url, body) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return await r.json();
    };
    const out = [];
    const seen = new Set();
    for (const ct of [2, 3]) {
      const tabRes = await post("/api/v1/config/aigc/get-tab-list", {
        creation_type: ct,
        jump_template_id: "",
        jump_tab_id: "",
        jump_sub_tab_id: "",
      });
      let tabs = tabRes?.data?.tab_list || [];
      // ct=3（智能P图侧）tab_list 为空 ⇒ 用 tab_id="" 直接取
      if (!tabs.length) tabs = [{ tab_id: "", tab_name: "智能P图" }];
      for (const t of tabs) {
        let index = 0;
        let total = 0;
        let guard = 0;
        do {
          const res = await post("/api/v1/config/aigc/get-template-list", {
            index,
            limit,
            creation_type: ct,
            tab_id: t.tab_id,
            template_id: "",
            group_chat_id: "",
            version: "",
            filter_count: 0,
          });
          const d = res?.data || {};
          total = d.total_count || 0;
          const items = Array.isArray(d.items) ? d.items : [];
          for (const it of items) {
            if (!it || !it.id || seen.has(it.id)) continue;
            seen.add(it.id);
            out.push({
              ct,
              tab: t.tab_name || "",
              name: it.name || "",
              id: it.id,
              gen_type: it.gen_type || "",
              min_count: it.min_count ?? 0,
              max_count: it.max_count ?? 0,
              disable_proportion: !!it.disable_proportion,
              prompt: it.prompt || "",
            });
          }
          index += items.length;
          if (!items.length) break;
          guard += 1;
        } while (index < total && guard < 40);
      }
    }
    return out;
  }, FETCH_LIMIT);
}

/**
 * 确保拿到模板列表：
 *   - 缓存新鲜（< TTL）⇒ 直接用
 *   - 给了 page ⇒ 在页面上下文里抓（带登录态），抓完写缓存
 *   - 没给 page ⇒ 起一个 headless 浏览器抓（供「列模板」工具用）
 * 抓取失败时回退到过期缓存；连过期缓存都没有才抛错。
 */
export async function ensureTemplates({ page, log = () => {}, allowLaunch = true } = {}) {
  const cached = await loadTemplateCache();
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (fresh) {
    log(`模板库用本地缓存：${cached.templates.length} 条`);
    return cached.templates;
  }

  const pull = async (p) => {
    const tpls = await fetchTemplatesInPage(p);
    if (!tpls.length) throw new Error("模板库返回空列表");
    await saveTemplateCache(tpls);
    log(`已拉取模板库：${tpls.length} 条`);
    return tpls;
  };

  if (page) {
    try {
      return await pull(page);
    } catch (e) {
      log(`模板库拉取失败（${e.message}），回退缓存`);
      if (cached) return cached.templates;
      throw e;
    }
  }

  if (allowLaunch) {
    const { chromium } = await import("patchright");
    const profileDir = process.env.DSH_YUANBAO_PROFILE || join(homedir(), ".dsh", "yuanbao-t2i-profile");
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1600, height: 950 },
      locale: "zh-CN",
    });
    try {
      const p = ctx.pages()[0] || (await ctx.newPage());
      await p.goto("https://yuanbao.tencent.com/chat/naQivTmsDa?chatMode=temp", {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await p.waitForTimeout(5000);
      return await pull(p);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  if (cached) return cached.templates;
  throw new Error("拿不到模板库（既无缓存也无法联网拉取）");
}

// ── 检索 ────────────────────────────────────────────────────────────────
const norm = (s) => String(s || "").replace(/[\s-‍﻿]/g, "").toLowerCase();

/** 模糊匹配模板名：完全一致 > 包含 > 双向包含 > 字面重合度 */
export function matchTemplate(templates, query) {
  const q = norm(query);
  if (!q) return null;
  let hit = templates.find((t) => norm(t.name) === q);
  if (hit) return hit;
  hit = templates.find((t) => norm(t.name).includes(q));
  if (hit) return hit;
  hit = templates.find((t) => q.includes(norm(t.name)) && norm(t.name).length >= 2);
  if (hit) return hit;
  // 字面重合度（模板名多为 4–8 个汉字）
  let best = null;
  let bestScore = 0;
  for (const t of templates) {
    const n = norm(t.name);
    if (!n) continue;
    let common = 0;
    for (const ch of new Set(q)) if (n.includes(ch)) common += 1;
    const score = common / Math.max(new Set(q).size, 1);
    if (score > bestScore && score >= 0.75) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/** 关键词检索（给「列模板」工具用） */
export function searchTemplates(templates, keyword, limit = 40) {
  const k = norm(keyword);
  const pool = k
    ? templates.filter((t) => norm(t.name).includes(k) || norm(t.prompt).includes(k))
    : templates;
  return pool.slice(0, Math.max(1, Math.min(200, limit)));
}

// ── 比例解析 ────────────────────────────────────────────────────────────
const RATIO_RE = /比例\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/;
const KEEP_RATIO_RE = /保持[^。；]{0,40}比例不变/;

/** 模板正文里声明的比例（"比例 3:4" → "3:4"；"保持上传图比例不变" → "智能比例"） */
export function templateRatio(prompt) {
  const p = String(prompt || "");
  if (KEEP_RATIO_RE.test(p)) return "智能比例";
  const m = RATIO_RE.exec(p);
  if (m) return `${m[1]}:${m[2]}`;
  return "";
}

/** 剥掉正文里的比例相关表述，避免与比例控件互相矛盾 */
function stripRatioWords(prompt) {
  return String(prompt || "")
    .replace(/保持[^。；]{0,40}比例不变[，,；。]?/g, "")
    .replace(/比例\s*\d{1,2}\s*[:：]\s*\d{1,2}[。.,，]?/g, "")
    .replace(/将上传图风格化[:：]?/g, "")
    .replace(/^[，,；。\s]+/, "");
}

/** 剥掉模板正文的指令前缀（「参考上传图生成图片：」之类） */
function stripDirectivePrefix(prompt) {
  const p = String(prompt || "").trim();
  const m = /^(.{0,30}?)[：:]\s*/.exec(p);
  if (m && /生成/.test(m[1])) return p.slice(m[0].length).trim();
  return p;
}

/** 没匹配上时，给出最接近的候选名（帮调用方改词） */
export function suggestTemplates(templates, query, limit = 8) {
  const q = norm(query);
  const scored = [];
  for (const t of templates) {
    if (t.gen_type !== "image2image") continue;
    const n = norm(t.name);
    if (!n) continue;
    let common = 0;
    for (const ch of new Set(q)) if (n.includes(ch)) common += 1;
    const score = common / Math.max(new Set(q).size, 1);
    if (score >= 0.4) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.t.name);
}

/**
 * 把模板画风套到用户提示词上。
 * @param {object} tpl 模板
 * @param {string} userPrompt 用户原始提示词
 * @param {string} userRatio 用户显式指定的比例（空＝没指定）
 * @param {boolean} hasRef 本次是否带参考图
 * @returns {{prompt:string, ratio:string, ratioSource:string, needsRef:boolean, notes:string[]}}
 */
export function applyStyle(tpl, userPrompt, userRatio, hasRef = false) {
  const notes = [];
  if (!tpl) throw new Error("没有匹配到模板");
  if (tpl.gen_type !== "image2image") {
    throw new Error(
      `「${tpl.name}」是成品场景模板（${tpl.gen_type}），不是画风模板，不能当 style 用。` +
        `画风请用 image2image 类模板（如「复古岩彩风」「马蒂斯野兽派」「日系复古平涂」）。`,
    );
  }
  const needsRef = (tpl.min_count ?? 0) > 0;
  let body = stripDirectivePrefix(tpl.prompt);
  body = stripRatioWords(body);
  body = body.replace(/^保持[^。；]{0,60}[；。]/, "").trim();
  if (!hasRef) {
    // 没有参考图时，模板里"参考上传图/保持原图…"这类措辞是空指令，剥掉
    body = body
      .replace(/保持[^。；]{0,60}(不变|不变；)[；。]?/g, "")
      .replace(/[^。；]{0,30}(上传图|参考图|原图)[^。；]{0,40}[；。]?/g, "")
      .trim();
  }
  if (!body) {
    notes.push("模板正文为空，只沿用原提示词");
    return { prompt: userPrompt, ratio: userRatio || "16:9", ratioSource: "默认", needsRef, notes };
  }

  // 比例：用户显式 > 模板自带 > 插件默认
  let ratio = "";
  let ratioSource = "";
  if (userRatio) {
    ratio = userRatio;
    ratioSource = "用户指定";
  } else {
    const tRatio = templateRatio(tpl.prompt);
    if (tRatio) {
      ratio = tRatio;
      ratioSource = "模板自带";
      notes.push(`模板自带比例 ${tRatio}（已从正文剥离，改由比例控件设置）`);
    }
  }

  const prompt = `${userPrompt}\n\n【画风预设：${tpl.name}】${body}`;
  notes.push(`已套用画风模板「${tpl.name}」（${tpl.tab || "未分类"}）`);
  return { prompt, ratio, ratioSource, needsRef, notes };
}
