// dsh-yuanbao-t2i · DSH 插件入口：注册 yuanbao_t2i 工具（腾讯元宝网页版文生图）
// 注册方式与 @liustack/modsearch 一致：inject tools，直接 ctx.tools.register 原生 JSON Schema。
import { join } from "node:path";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { generate } from "./generate.js";
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
async function cleanWatermark(files, { outDir, wmRoi, wmMask, wmEngine, lamaPython, lamaDevice, log }) {
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
    refImages: { type: "array", items: { type: "string" } },
    dstIntent: { type: "string" },
    imageRatio: { type: "string" },
    seed: { type: "number" },
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
      "用腾讯元宝网页版（混元 Hy Image）文生图：传中文提示词，生成 4 张 PNG 并保存到本地，返回文件路径。" +
      "会弹出一个浏览器窗口（首次需微信扫码登录，之后登录态持久化）。单次约 30–90 秒。" +
      "有账号风控风险：不要高频连续调用，批量任务之间留间隔。提示词宜具体：主体+动作+环境+风格+构图。" +
      "图片带「元宝 AI生成」水印；是否自动去水印、修复范围，由用户在插件设置卡（DSH 设置 → 插件 → dsh-yuanbao-t2i → 生成设置）里选，也可用参数临时覆盖。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "中文生图提示词" },
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
          enum: ["16:9", "3:4", "ref:1"],
          description: "输出图片比例（可选，默认 16:9）。图生图时可选 ref:1（跟随参考图）",
        },
        seed: { type: "number", description: "随机种子（可选，固定后可复现）" },
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
            ? `元宝生图完成，共 ${v.count} 张：\n${v.files.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
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
      const seed = typeof args.seed === "number" ? args.seed : undefined;

      // 界面设置＝默认值；单次调用可覆盖（args 里显式给了就以 args 为准）
      const stored = await readSettings();
      const outDir = args.outDir || stored.outDir || defaultOutDir;
      const removeWatermark =
        args.removeWatermark === undefined ? stored.removeWatermark === true : args.removeWatermark === true;
      const wmEngine = args.wmEngine || stored.wmEngine;
      const wmMask = args.wmMask || stored.wmMask;
      return serialize(async () => {
        try {
          const r = await generate({
            prompt,
            refImages,
            dstIntent,
            imageRatio,
            seed,
            profileDir,
            outDir,
            headless: false,
            timeoutMs: 240000,
            log,
          });
          let cleaned = null;
          if (removeWatermark) {
            try {
              cleaned = await cleanWatermark(r.files, { outDir, ...wmCfg, wmEngine, wmMask });
            } catch (e) {
              log(`去水印失败（保留原图继续）：${e.message}`);
            }
          }
          return { ok: true, count: r.count, files: cleaned || r.files, rawFiles: r.files, prompt, refImages, dstIntent, imageRatio, seed };
        } catch (e) {
          return { ok: false, count: 0, files: [], prompt, error: String(e?.message || e) };
        }
      });
    },
  });
}

export { cleanWatermark, runPython };

export default { name, inject, apply };
