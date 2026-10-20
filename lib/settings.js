// 插件设置（界面可改）：~/.dsh/yuanbao-t2i-config.json
// 只存「默认行为」，单次调用仍可用参数覆盖。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const HOME = process.env.USERPROFILE || process.env.HOME || ".";

export const SETTINGS_PATH =
  process.env.DSH_YUANBAO_SETTINGS || join(HOME, ".dsh", "yuanbao-t2i-config.json");

export const DEFAULTS = {
  // 生成后是否自动去水印（主人 2026-10-20：由用户在插件界面里选）
  removeWatermark: false,
  // 去水印引擎：只剩 lama（Big-LaMa）；telea 已于 v0.5.0 下架
  wmEngine: "lama",
  // 掩膜：tight=只修字形（默认，痕轻）；rect=整块矩形（稳，但糊一片）
  wmMask: "tight",
  // 输出目录：空字符串＝用插件默认（~/.dsh/yuanbao-t2i-out）
  outDir: "",
};

// 只保留 lama：MIGAN/MAT/ZITS/telea 全部实测否决（见 README）
const ENGINES = new Set(["lama"]);
const MASKS = new Set(["tight", "rect"]);
const MAX_OUTDIR = 240;

function cleanDir(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // 去掉控制字符（含 NUL）：Windows 路径里非法，写盘会直接炸
  const stripped = trimmed.replace(/[\u0000-\u001f]/g, "");
  return stripped.length > MAX_OUTDIR ? "" : stripped;
}

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.removeWatermark === "boolean") out.removeWatermark = raw.removeWatermark;
  if (typeof raw.wmEngine === "string" && ENGINES.has(raw.wmEngine)) out.wmEngine = raw.wmEngine;
  if (typeof raw.wmMask === "string" && MASKS.has(raw.wmMask)) out.wmMask = raw.wmMask;
  out.outDir = cleanDir(raw.outDir);
  return out;
}

export async function readSettings() {
  try {
    const text = await readFile(SETTINGS_PATH, "utf8");
    return sanitize(JSON.parse(text));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeSettings(patch) {
  const next = sanitize({ ...(await readSettings()), ...(patch || {}) });
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}
