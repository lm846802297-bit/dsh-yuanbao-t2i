// dsh-yuanbao-t2i · DSH 插件入口：注册 yuanbao_t2i 工具（腾讯元宝网页版文生图）
// 注册方式与 @liustack/modsearch 一致：inject tools，直接 ctx.tools.register 原生 JSON Schema。
import { join } from "node:path";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { generate } from "./generate.js";
import { ensureTemplates, searchTemplates, templateCachePath } from "./templates.js";
import { readSettings } from "./settings.js";
import { registerSettingsRoute } from "./route.js";

export const name = "dsh-yuanbao-t2i";
export const inject = ["tools"];

const HOME = process.env.USERPROFILE || process.env.HOME || ".";

// 路径解析：先看环境变量/插件配置，其次本机已知位置，最后回落到 PATH 上的 python。
// （写成候选列表是为了「本机能跑 + 公开仓库里不写死某个人的绝对路径」。）
function firstExisting(candidates, fallback) {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return fallback;
}
function pythonCandidates(envName, preferredEnv) {
  return [
    process.env[envName],
    join(HOME, ".workbuddy", "binaries", "python", "envs", preferredEnv, "Scripts", "python.exe"),
    join(HOME, ".dsh", "python", "python.exe"),
  ];
}

// 去水印只保留 lama（Big-LaMa）一个引擎。MIGAN / MAT / ZITS / telea 全部实测否决
// （理由见 README「为什么没有接入 MAT / ZITS」）；telea 于 v0.5.0 下架——它要外挂一个
// 仓库外的 clean_watermark.py（cv2 解释器），接线复杂度高而质量明显低于 lama。
// 元宝 2026-10 批水印实测 ROI：文字本体约 x0.74-0.96 y0.895-0.975。
// 早期把 ROI 放到 0.68,0.86,1.0,1.0（探针外扩余量），LaMa 要重修 4.5% 面积、smooth 痕明显；
// 收紧到只包住文字本体后重修面积降到约 2.5%，实测 6 张样本无残留、修痕变轻。可用 wmRoi 参数覆盖。
const WM_ROI_DEFAULT = process.env.DSH_WM_ROI || "0.71,0.878,0.992,0.996";
// 掩膜模式：tight=ROI 内检出字形后只修字形（实测痕轻很多）；rect=整块矩形重绘（稳但糊）
const WM_MASK_DEFAULT = process.env.DSH_WM_MASK || "tight";
// 引擎注册表：只剩 lama（Big-LaMa 深度模型，GPU 优先）；telea 已于 v0.5.0 下架
const LAMA_PY_DEFAULT = firstExisting(
  pythonCandidates("DSH_LAMA_PYTHON", "default"),
  process.env.DSH_LAMA_PYTHON || "python",
);
const WM_LAMA_SCRIPT = join(import.meta.dirname, "wm_lama.py");

async function runPython(exe, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let out = "";
    const t = setTimeout(() => { p.kill(); reject(new Error("去水印脚本超时")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("exit", (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`去水印脚本退出码 ${code}：${out.slice(-400)}`)); });
  });
}

// 对本次生成的文件做去水印：拷进独立临时目录 → wm_lama.py 处理 → 返回清理后文件列表
// 输出持久落在 <outDir>/clean/（stem 含时间戳，跨次不冲突）
async function cleanWatermark(files, { outDir, wmRoi, wmMask, wmEngine, lamaPython, lamaDevice, log = () => {} }) {
  const runDir = await mkdtemp(join(tmpdir(), "yuanbao-wm-"));
  const dst = join(outDir, "clean");
  try {
    for (const f of files) await cp(f, join(runDir, f.split(/[\\/]/).pop()));
    if (wmEngine && wmEngine !== "lama") {
      throw new Error(`去水印引擎 "${wmEngine}" 已于 v0.5.0 下架（只保留 lama）。请改用 wmEngine: "lama"`);
    }
    const args = [WM_LAMA_SCRIPT, "--src", runDir, "--dst", dst, "--roi", wmRoi, "--mask", wmMask || WM_MASK_DEFAULT];
    if (lamaDevice) args.push("--device", lamaDevice);
    // --ctx 缺省即走 wm_lama.py 的 64（实测：160 会让裁切块比 ROI 自身还大 3-5 倍，变相糊背景）
    const wmCtx = Number(process.env.DSH_WM_CTX || 0);
    if (wmCtx > 0) args.push("--ctx", String(wmCtx));
    log(`去水印引擎：lama（Big-LaMa）`);
    await runPython(lamaPython, args);
    const names = (await readdir(dst)).filter((n) => /\.(jpe?g|png)$/i.test(n) && !n.startsWith("_check_"));
    const cleaned = names
      .map((n) => join(dst, n))
      .filter((p) => files.some((f) => p.includes(f.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""))));
    if (!cleaned.length) throw new Error("去水印脚本未产出任何图片");
    log(`去水印完成：${cleaned.length} 张 -> ${dst}`);
    return cleaned;
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    count: { type: "number" },
    files: { type: "array", items: { type: "string" } },
    rawFiles: { type: "array", items: { type: "string" } },
    prompt: { type: "string" },
    effectivePrompt: { type: "string" },
    refImages: { type: "array", items: { type: "string" } },
    dstIntent: { type: "string" },
    imageRatio: { type: "string" },
    imageResolution: { type: "string" },
    imageModel: { type: "string" },
    style: { type: "object" },
    watermarkError: { type: "string" },
    error: { type: "string" },
  },
  required: ["ok", "count", "files", "prompt"],
};

// 同一个持久化 profile 不能被两个浏览器同时打开 ⇒ 串行化所有调用
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export function apply(ctx, config = {}) {
  const profileDir =
    config.profileDir || process.env.DSH_YUANBAO_PROFILE || join(HOME, ".dsh", "yuanbao-t2i-profile");
  const defaultOutDir = config.outDir || join(HOME, ".dsh", "yuanbao-t2i-out");
  const wmCfg = {
    wmRoi: config.wmRoi || WM_ROI_DEFAULT,
    wmMask: config.wmMask || WM_MASK_DEFAULT,
    wmEngine: config.wmEngine || "lama",
    lamaPython: config.lamaPython || process.env.DSH_LAMA_PYTHON || LAMA_PY_DEFAULT,
    lamaDevice: config.lamaDevice || "",
  };
  const log = (m) => ctx.logger?.info?.(`[yuanbao-t2i] ${m}`);

  // 插件界面（Plugins 页设置卡）读写同一份配置：/yuanbao-t2i/config
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (scope) => {
      try {
        registerSettingsRoute(scope);
      } catch (e) {
        log(`设置路由注册失败：${e.message}`);
      }
    });
  }

  ctx.tools.register({
    name: "yuanbao_t2i",
    description:
      "用腾讯元宝网页版（混元 Hy Image）生图：传中文提示词即可文生图（生成 4 张并保存到本地，返回文件路径）；" +
      "传 refImages（本地文件/URL/文件夹，≤5 张）即走图生图，基于参考图改写（走元宝前端原生上传通道，参考图由浏览器页面上传）。" +
      "会弹出一个浏览器窗口（首次需微信扫码登录，之后登录态持久化）。单次约 30–90 秒。" +
      "有账号风控风险：不要高频连续调用，批量任务之间留间隔。提示词宜具体：主体+动作+环境+风格+构图。" +
      "图片带「元宝 AI生成」水印；是否自动去水印、修复范围，由用户在插件设置卡（DSH 设置 → 插件 → dsh-yuanbao-t2i → 生成设置）里选，也可用参数临时覆盖。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "中文生图提示词" },
        style: {
          type: "string",
          description:
            "画风预设（可选）：填元宝官方模板库里的画风模板名，如「复古岩彩风」「马蒂斯野兽派」「日系复古平涂」「新中式工笔重彩」。" +
            "模板自带完整画风描述，会自动追加到提示词后面。比例优先级：显式传的 imageRatio > 模板自带比例 > 默认 16:9。" +
            "先用 yuanbao_t2i_styles 查有哪些画风",
        },
        refImages: {
          type: "array",
          items: { type: "string" },
          description: "参考图路径列表（可选，≤5 张）。支持本地文件路径/URL/文件夹路径（自动遍历图片）。传了即走图生图（dstIntent 自动切 Image2Image）",
        },
        dstIntent: {
          type: "string",
          enum: ["Text2Image", "Image2Image"],
          description: "生成模式（可选）。不传＝自动判断（有 refImages 就是 Image2Image，否则 Text2Image）",
        },
        imageRatio: {
          type: "string",
          enum: ["智能比例", "1:1", "4:3", "3:4", "16:9", "9:16", "ref:1"],
          description:
            "输出图片比例（可选，默认 16:9）。✅ 真生效：插件会切到元宝「AI 生图」模式并点选比例控件，" +
            "协议落点为请求体 extra.image_gen_param.ratio（实测 16:9 → 出图 2240x1248）。" +
            "「智能比例」＝服务端自动挑（不动）；ref:1 是「智能比例」的旧别名（跟随参考图）",
        },
        imageResolution: {
          type: "string",
          enum: ["1.5K", "2K"],
          description: "输出分辨率（可选）。✅ 真生效：协议落点 extra.image_gen_param.resolution。⚠️ 仅「AI 生图」模式下可选；不传＝用元宝默认（当前账号默认 2K）",
        },
        imageModel: {
          type: "string",
          enum: ["Hy Image3.5 preview"],
          description: "生图模型（可选）。✅ 真生效：协议落点 extra.image_gen_param.model。当前元宝只提供 Hy Image3.5 preview 一个选项",
        },
        outDir: { type: "string", description: `保存目录（绝对路径，可选；不传＝用插件界面设置，界面留空则用默认 ${defaultOutDir}）` },
        removeWatermark: { type: "boolean", description: "是否去除右下角水印。⛔ 不传＝用插件界面（设置 → 插件 → dsh-yuanbao-t2i）里的开关；传 true/false 可临时覆盖。开启时产物写 outDir/clean/，原图保留" },
        wmEngine: { type: "string", enum: ["lama"], description: "去水印引擎（仅开启去水印时生效），当前只接受 lama（Big-LaMa 深度模型，GPU 约 1–3 秒/张）。telea / MIGAN / MAT / ZITS 均已实测下架，理由见 README「为什么没有接入 MAT / ZITS」" },
        wmMask: { type: "string", enum: ["tight", "rect"], description: "修复范围（仅 lama 引擎）。不传＝用插件界面设置（默认 tight）。tight=只修字形（痕轻、保结构）；rect=整块矩形重绘（稳，但插画类会糊一片）" },
      },
      required: ["prompt"],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, v) => [
        {
          type: "text",
          text: v.ok
            ? `元宝生图完成，共 ${v.count} 张：\n${v.files.map((f, i) => `${i + 1}. ${f}`).join("\n")}` +
              (v.watermarkError ? `\n\n⚠️ 去水印未生效（返回的是带水印原图）：${v.watermarkError}` : "")
            : `元宝生图失败：${v.error}`,
        },
      ],
    },
    timeoutMs: 330000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: "generic", title: "yuanbao_t2i", kind: "other", rawInput: args }),
    async execute(args) {
      if (typeof args?.prompt !== "string" || !args.prompt.trim()) {
        throw new Error('yuanbao_t2i 需要非空字符串 "prompt"');
      }
      const prompt = args.prompt.trim();
      const refImages = Array.isArray(args.refImages) ? args.refImages : [];
      const dstIntent = args.dstIntent || (refImages.length > 0 ? "Image2Image" : "Text2Image");
      const imageRatio = args.imageRatio || "16:9";
      // 用户是否显式传了比例（显式 > 画风模板自带 > 默认）
      const imageRatioExplicit = typeof args.imageRatio === "string" && args.imageRatio.trim() !== "";
      const imageResolution = args.imageResolution || "";
      const imageModel = args.imageModel || "";
      const style = typeof args.style === "string" ? args.style.trim() : "";

      // 界面设置＝默认值；单次调用可覆盖（args 里显式给了就以 args 为准）
      const stored = await readSettings();
      const outDir = args.outDir || stored.outDir || defaultOutDir;
      const removeWatermark =
        args.removeWatermark === undefined ? stored.removeWatermark === true : args.removeWatermark === true;
      const wmEngine = args.wmEngine || stored.wmEngine;
      const wmMask = args.wmMask || stored.wmMask;
      // 引擎已于 v0.5.0 只剩 lama：参数非法就直接抛错，
      // 不要静默跳过去水印（否则调用方以为已去水印，实际拿到的是带水印原图）。
      if (wmEngine && wmEngine !== "lama") {
        throw new Error(`去水印引擎 "${wmEngine}" 已于 v0.5.0 下架（只保留 lama）。请改用 wmEngine: "lama" 或不传该参数`);
      }
      return serialize(async () => {
        try {
          const r = await generate({
            prompt,
            refImages,
            dstIntent,
            imageRatio,
            imageRatioExplicit,
            imageResolution,
            imageModel,
            style,
            profileDir,
            outDir,
            headless: false,
            timeoutMs: 240000,
            log,
          });
          let cleaned = null;
          let watermarkError = "";
          if (removeWatermark) {
            try {
              // ⚠️ log 必须显式传进去：cleanWatermark 内部会 log()，缺省会抛
              //    "log is not a function"，被下面的 catch 吞掉 ⇒ 去水印静默失败、
              //    返回的还是带水印的原图（v0.8.0 真机日志实证）。
              cleaned = await cleanWatermark(r.files, { outDir, ...wmCfg, wmEngine, wmMask, log });
            } catch (e) {
              watermarkError = String(e?.message || e);
              log(`去水印失败（保留原图继续）：${watermarkError}`);
            }
          }
          return { ok: true, count: r.count, files: cleaned || r.files, rawFiles: r.files, prompt, effectivePrompt: r.effectivePrompt, refImages, dstIntent, imageRatio, imageResolution, imageModel, style: r.style, watermarkError };
        } catch (e) {
          return { ok: false, count: 0, files: [], prompt, error: String(e?.message || e) };
        }
      });
    },
  });

  // ── 画风预设检索：列出元宝官方模板库里的画风模板 ──────────────────
  // 只暴露 image2image 类（真正的「画风/效果」模板）；text2image 类是成品场景
  // 模板（电商海报之类），当画风用会和用户自己的画面描述打架，不给。
  ctx.tools.register({
    name: "yuanbao_t2i_styles",
    description:
      "列出腾讯元宝官方模板库里的「画风预设」名（可按关键词过滤）。" +
      "拿到名字后传给 yuanbao_t2i 的 style 参数即可套用该画风。" +
      "首次调用会联网拉一次模板库并落盘缓存（约 1800 条，一周刷新一次），之后走本地缓存。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "关键词（可选）：按画风名或正文过滤，如「岩彩」「水彩」「油画」" },
        limit: { type: "number", description: "最多返回条数（可选，默认 30，上限 200）" },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          count: { type: "number" },
          total: { type: "number" },
          cachePath: { type: "string" },
          styles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                tab: { type: "string" },
                ratio: { type: "string" },
                needsRef: { type: "boolean" },
                snippet: { type: "string" },
              },
            },
          },
          error: { type: "string" },
        },
        required: ["ok", "count", "styles"],
      },
      render: (_args, v) => [
        {
          type: "text",
          text: v.ok
            ? `画风预设 ${v.count} 条（模板库共 ${v.total} 条）：\n${v.styles.map((s) => `- ${s.name}（${s.tab}｜${s.ratio || "比例未指定"}${s.needsRef ? "｜需参考图" : ""}）`).join("\n")}`
            : `取画风列表失败：${v.error}`,
        },
      ],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: "generic", title: "yuanbao_t2i_styles", kind: "other", rawInput: args }),
    async execute(args) {
      return serialize(async () => {
        try {
          const tpls = await ensureTemplates({ log });
          const i2i = tpls.filter((t) => t.gen_type === "image2image");
          const limit = Math.max(1, Math.min(200, Number(args?.limit) || 30));
          const hits = searchTemplates(i2i, args?.keyword, limit);
          const styles = hits.map((t) => ({
            name: t.name,
            tab: t.tab,
            ratio: /比例\s*\d+\s*[:：]\s*\d+/.test(t.prompt)
              ? (/比例\s*(\d+)\s*[:：]\s*(\d+)/.exec(t.prompt) || []).slice(1, 3).join(":")
              : (/保持[^。；]{0,40}比例不变/.test(t.prompt) ? "智能比例" : ""),
            needsRef: (t.min_count ?? 0) > 0,
            snippet: String(t.prompt || "").slice(0, 120),
          }));
          return { ok: true, count: styles.length, total: i2i.length, cachePath: templateCachePath(), styles };
        } catch (e) {
          return { ok: false, count: 0, total: 0, styles: [], error: String(e?.message || e) };
        }
      });
    },
  });
}

export { cleanWatermark, runPython };

export default { name, inject, apply };
