# -*- coding: utf-8 -*-
"""wm_lama.py — LaMa 引擎去水印（simple-lama-inpainting，GPU/CPU 自适应）。

用法：
  python wm_lama.py --src <目录> --dst <目录> --roi x0,y0,x1,y1 [--mask auto|tight|rect] [--device cuda]

掩膜模式（v0.10.0 起默认 auto）：
  rect  ROI 整块白矩形交给 LaMa 重建 —— 最稳、但重修面积大，插画类会「糊一片」。
  tight 在 ROI 内检出字形，膨胀成紧贴字形的掩膜后再修 —— 重修面积小得多、痕更轻。
  auto  （默认）先走 tight 精确检测；检测不可信就自动降级 rect，修完还做一道「残痕自检」，
        自检不过再用 rect 重修。⇒ 调用方不用再关心选哪个。

检测口径（v0.10.0 重写，旧口径有真 bug）：
  旧实现：阈值取 ROI 亮度分布的 p99.5 / p0.5，两端各出一个候选，取**命中面积更小**的一端。
  ⚠️ 实测 8 张真样本：3 张选中端命中率只有 0.65% / 0.07% / 0.00% ——「面积更小」被当成
  「更干净」，其实是**检测失效**（掩膜近空）⇒ 水印原样留着，且不报错、不降级。
  新实现：
    ① **位置先验**：水印固定在 ROI 的相对框内（PRIOR_BOX），只在这一带检测 ⇒ 大面积纹理误判消失。
    ② **局部背景**：用大核中值滤波（MED_K=41，比字形笔画宽）估计背景，取 |亮度-背景| 作笔画强度
       —— 不再区分「亮笔画/暗笔画」，白底暗字与暗底亮字同一套逻辑。
    ③ **自适应阈值**：delta = max(6, 2.5 × MAD)，MAD 在全 ROI 低饱和像素上算 ⇒ 干净图 delta 小、
       脏图 delta 大。
    ④ **可信度闸**：命中率必须落在 [0.5%, 25%]（占 ROI）。低于下限＝检测失效；高于上限＝把背景
       当字形 ⇒ 都判不可信，auto 模式下降级 rect。
    ⑤ **残痕自检**：tight 修完后再用同一套检测跑一遍输出图，若仍检出 ≥ max(0.4%, 35% 原始命中)
       的笔画 ⇒ 判定没修净 ⇒ 用 rect 重修（并打印原因）。
  仍可用 --thr/--sat/--dilate 显式覆盖。

tight 的上下文：以掩膜外接框外扩 --ctx 像素裁切，只把这块送进模型，回填时按羽化掩膜混合，
避免接缝。--ctx 不是越大越好：实测 16 张全样本，ctx=160 时裁切块 16-42 万 px，
而 ROI 本身只有 7.5-8.0 万 px ⇒ 白送 3-5 倍面积进模型（LaMa 会把整块重绘，等于变相糊背景）。
默认收到 64（裁切块总面积降到 1/2.5），仍留有足够上下文让接缝自然。
"""
import argparse
import os

# ── 水印几何／检测参数（集中在这里，便于回归与调参）────────────────────────────
PRIOR_BOX = (0.60, 0.50, 0.98, 0.95)   # 水印必落在此框内（相对 ROI 的 x0,y0,x1,y1）
MED_K = 41                             # 局部背景中值核（> 笔画宽度，实测笔画 ~8-12px）
MAD_MULT = 2.5
MAD_FLOOR = 6.0
MIN_HIT = 0.005                        # 命中率下限（占 ROI），低于此判「检测失效」
MAX_HIT = 0.25                         # 命中率上限，高于此判「把背景当字形」
SELF_CHECK_RATIO = 0.35                # 残痕自检：残留 / 原始命中 超过此比例 ⇒ 判没修净
SELF_CHECK_FLOOR = 0.004


def build_rect_mask(w, h, roi):
    """ROI 整块白矩形。坐标先夹紧到图内并保证 x1>x0、y1>y0。

    ⚠️ 夹紧不是洁癖：roi 来自调用方的 `wmRoi` 参数或 DSH_WM_ROI 环境变量，
    传反了（x0>x1）时 PIL 的 rectangle 会直接抛 `ValueError: x1 must be greater than
    or equal to x0` ⇒ 整个去水印步骤崩掉（实测踩过）。夹紧后退化成 1px 掩膜，
    LaMa 基本不动原图，属于「安全失败」。
    """
    from PIL import Image, ImageDraw

    x0 = max(0, min(w - 1, int(round(float(roi[0]) * w))))
    y0 = max(0, min(h - 1, int(round(float(roi[1]) * h))))
    x1 = max(x0 + 1, min(w, int(round(float(roi[2]) * w))))
    y1 = max(y0 + 1, min(h, int(round(float(roi[3]) * h))))
    px = Image.new("L", (w, h), 0)
    ImageDraw.Draw(px).rectangle([x0, y0, x1 - 1, y1 - 1], fill=255)
    return px


def detect_glyph(img, roi, sat=45, med_k=MED_K, mult=MAD_MULT, floor=MAD_FLOOR):
    """在 ROI 内检测水印笔画像素（v2 口径）。返回 dict：

    glyph  bool ndarray（ROI 尺寸，True＝笔画像素）
    hit    命中率（占 ROI 面积）
    delta  实际使用的阈值
    mad    低饱和像素 |亮度-局部背景| 的中位数
    box    检测带（ROI 内像素坐标 x0,y0,x1,y1）
    """
    import numpy as np
    from PIL import Image, ImageFilter

    w, h = img.size
    x0, y0, x1, y1 = int(roi[0] * w), int(roi[1] * h), int(roi[2] * w), int(roi[3] * h)
    sub = img.crop((x0, y0, x1, y1))
    a = np.asarray(sub).astype(np.int16)
    lum = a.mean(axis=2)
    mx, mn = a.max(axis=2), a.min(axis=2)
    lowsat = (mx - mn) < sat

    med = np.asarray(
        Image.fromarray(np.clip(lum, 0, 255).astype(np.uint8)).filter(
            ImageFilter.MedianFilter(med_k)
        )
    ).astype(np.float32)
    dev = np.abs(lum.astype(np.float32) - med)

    sh, sw = lum.shape
    bx0, by0 = int(PRIOR_BOX[0] * sw), int(PRIOR_BOX[1] * sh)
    bx1, by1 = int(PRIOR_BOX[2] * sw), int(PRIOR_BOX[3] * sh)
    box = np.zeros((sh, sw), dtype=bool)
    box[by0:by1, bx0:bx1] = True

    sample = dev[lowsat]
    mad = float(np.median(sample)) if sample.size else 0.0
    delta = max(floor, mult * mad)
    glyph = (dev > delta) & box & lowsat
    total = max(1, sw * sh)
    return {
        "glyph": glyph,
        "hit": float(glyph.sum()) / total,
        "delta": float(delta),
        "mad": float(mad),
        "box": (bx0, by0, bx1, by1),
    }


def build_tight_mask(img, roi, thr, sat, dilate):
    """检出字形并膨胀成掩膜。返回 (mask, note, info)。

    info["ok"] is False ⇒ 检测不可信（此时返回的是 rect 掩膜，调用方应把模式当 rect 处理）。
    thr 非 None 时走固定阈值（旧行为，保留给 --thr 显式覆盖）。
    """
    import numpy as np
    from PIL import Image, ImageFilter

    w, h = img.size
    x0, y0, x1, y1 = int(roi[0] * w), int(roi[1] * h), int(roi[2] * w), int(roi[3] * h)
    if x1 <= x0 or y1 <= y0:
        return build_rect_mask(w, h, roi), "ROI 非法，回退 rect", {"ok": False, "hit": 0.0, "why": "roi_invalid"}

    if thr is None:
        d = detect_glyph(img, roi, sat)
        hit = d["hit"]
        detail = (f"v2检测 命中 {hit:.2%}（delta={d['delta']:.0f} mad={d['mad']:.2f} "
                  f"带={d['box']}）")
        if hit < MIN_HIT:
            return build_rect_mask(w, h, roi), (
                f"检测失效：命中仅 {hit:.2%} < {MIN_HIT:.1%} ⇒ 降级 rect（{detail}）"
            ), {"ok": False, "hit": hit, "why": "hit_low"}
        if hit > MAX_HIT:
            return build_rect_mask(w, h, roi), (
                f"检测不可信：命中 {hit:.2%} > {MAX_HIT:.0%} ⇒ 降级 rect（{detail}）"
            ), {"ok": False, "hit": hit, "why": "hit_high"}
        glyph = d["glyph"].astype(np.uint8) * 255
        note = f"字形掩膜 {detail} sat={sat} dilate≈{dilate}px"
    else:
        sub = np.asarray(img.crop((x0, y0, x1, y1))).astype(np.int16)
        mx, mn = sub.max(axis=2), sub.min(axis=2)
        lowsat = (mx - mn) < sat
        glyph = ((mx > thr) & lowsat).astype(np.uint8) * 255
        total = max(1, sub.shape[0] * sub.shape[1])
        nsel = int((glyph > 0).sum())
        if nsel == 0:
            return build_rect_mask(w, h, roi), (
                f"ROI 内未检出字形（thr={thr} sat={sat}），回退 rect"
            ), {"ok": False, "hit": 0.0, "why": "thr_empty"}
        hit = nsel / total
        if hit > 0.6:
            return build_rect_mask(w, h, roi), (
                f"固定阈值命中面积 {hit:.0%} 超 ROI 60%（疑似白底/亮背景误遮），回退 rect"
            ), {"ok": False, "hit": hit, "why": "thr_toobig"}
        note = f"字形掩膜 thr={thr} sat={sat} 命中 {hit:.2%} dilate≈{dilate}px"

    mask = Image.fromarray(glyph)
    # PIL 的 MaxFilter 只吃小核，重复几次累计膨胀（9 核≈每边 +4px，7 次≈28px，够包住字边）
    if dilate > 0:
        steps = max(1, round(dilate / 4))
        for _ in range(steps):
            mask = mask.filter(ImageFilter.MaxFilter(9))
    full = Image.new("L", (w, h), 0)
    full.paste(mask, (x0, y0))
    return full, note, {"ok": True, "hit": hit, "why": ""}


def area_stats(orig, out, roi, thr=6):
    """度量「到底改了多少」：ROI 内改动面积占比、ROI 外改动像素数、全图平均绝对差。

    为什么要运行时打印：v0.10.0 之前想知道掩膜是不是近空，只能事后另写脚本做 A/B；
    做成常驻读数后，任何一张图的日志就能自证「走了哪条路、改了多少、有没有渗出 ROI」。

    ROI 外改动**必须恒为 0**：tight 只回填「掩膜+上下文」那一块（块在 ROI 内），
    rect 只重绘 ROI 矩形。一旦非 0，说明有整图重建的路径混进来了 —— 这个量比
    「水印有没有修掉」更早暴露退化（整图重建会把画面洗平，而日志全绿）。
    """
    import numpy as np

    w, h = orig.size
    x0 = max(0, min(w - 1, int(round(float(roi[0]) * w))))
    y0 = max(0, min(h - 1, int(round(float(roi[1]) * h))))
    x1 = max(x0 + 1, min(w, int(round(float(roi[2]) * w))))
    y1 = max(y0 + 1, min(h, int(round(float(roi[3]) * h))))
    a = np.asarray(orig.convert("RGB")).astype(np.int16)
    b = np.asarray(out.convert("RGB")).astype(np.int16)
    if a.shape != b.shape:
        return {"roi_pct": 100.0, "outside_px": -1, "mean_abs": -1.0, "box": (x0, y0, x1, y1)}
    d = np.abs(a - b).max(axis=2)
    inside = np.zeros(d.shape, dtype=bool)
    inside[y0:y1, x0:x1] = True
    sub = d[inside]
    return {
        "roi_pct": float((sub > thr).mean() * 100.0) if sub.size else 0.0,
        "outside_px": int((d[~inside] > thr).sum()),
        "mean_abs": float(d.mean()),
        "box": (x0, y0, x1, y1),
    }


def repair_tight(lama, img, mask, ctx):
    """tight 路径：只把「掩膜 + 上下文」这一块送模型，回填时按羽化掩膜混合，避免整图重建。"""
    from PIL import Image, ImageFilter

    w, h = img.size
    bbox = mask.getbbox()
    if not bbox:
        return None
    x0 = max(0, bbox[0] - ctx)
    y0 = max(0, bbox[1] - ctx)
    x1 = min(w, bbox[2] + ctx)
    y1 = min(h, bbox[3] + ctx)
    crop = img.crop((x0, y0, x1, y1))
    crop_mask = mask.crop((x0, y0, x1, y1))
    filled = lama(crop, crop_mask).convert("RGB")
    # SimpleLama 只往右/下 pad 到 8 的倍数，输出会比输入大几像素，裁回原尺寸
    filled = filled.crop((0, 0, crop.width, crop.height))
    soft = crop_mask.filter(ImageFilter.GaussianBlur(2.0))
    out = img.copy()
    out.paste(Image.composite(filled, crop, soft), (x0, y0))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--roi", required=True, help="x0,y0,x1,y1 相对比例")
    ap.add_argument("--mask", default="auto", choices=["auto", "tight", "rect"],
                    help="掩膜模式：auto（默认，自适应）/ tight（强制紧贴字形）/ rect（强制整块）")
    ap.add_argument("--thr", type=int, default=None,
                    help="tight：固定亮度阈值（0-255）；缺省＝v2 自适应检测")
    ap.add_argument("--sat", type=int, default=45, help="tight：最大通道差上限（越低越只认灰白）")
    ap.add_argument("--dilate", type=int, default=25, help="tight：掩膜膨胀半径（像素）")
    ap.add_argument("--ctx", type=int, default=64, help="tight：送模型的上下文外扩（像素）")
    ap.add_argument("--selfcheck", default="1", choices=["0", "1"],
                    help="修完做残痕自检，不过则用 rect 兜底（1=开，默认）")
    ap.add_argument("--device", default=None, help="cuda / cpu（默认自动）")
    a = ap.parse_args()

    roi = tuple(float(v) for v in a.roi.split(","))
    if len(roi) != 4:
        print("[wm_lama] --roi 需要 4 个数", flush=True)
        return 2
    os.makedirs(a.dst, exist_ok=True)

    from PIL import Image
    from simple_lama_inpainting import SimpleLama
    import torch

    device = a.device or ("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[wm_lama] device={device} mask={a.mask} selfcheck={a.selfcheck}", flush=True)
    lama = SimpleLama(device=device)

    exts = (".png", ".jpg", ".jpeg", ".webp")
    n = 0
    used_hist = {"tight": 0, "rect": 0}
    roi_pcts = []
    outside_total = 0
    degraded_n = 0
    for name in sorted(os.listdir(a.src)):
        if not name.lower().endswith(exts) or name.startswith("_"):
            continue
        img = Image.open(os.path.join(a.src, name)).convert("RGB")
        w, h = img.size
        requested = a.mask
        used = None
        degraded = ""
        info = {"ok": False, "hit": 0.0, "why": ""}
        note = ""

        if requested in ("auto", "tight"):
            mask, note, info = build_tight_mask(img, roi, a.thr, a.sat, a.dilate)
            print(f"[wm_lama] {name}: {note}", flush=True)
            if info["ok"]:
                used = "tight"
            else:
                used = "rect"
                degraded = info.get("why") or "untrusted"
                if requested == "tight":
                    print(f"[wm_lama] {name}: 强制 tight 但检测不可信（{degraded}），按 rect 处理",
                          flush=True)
        if used is None:
            used = "rect"
        if used == "rect":
            mask = build_rect_mask(w, h, roi)

        if not mask.getbbox():
            print(f"[wm_lama] {name}: 掩膜为空，回退 rect", flush=True)
            mask = build_rect_mask(w, h, roi)
            used = "rect"
            degraded = degraded or "empty_mask"

        if used == "tight":
            out = repair_tight(lama, img, mask, a.ctx)
            if out is None:
                out = lama(img, build_rect_mask(w, h, roi)).convert("RGB").crop((0, 0, w, h))
                used = "rect"
                degraded = degraded or "empty_bbox"
        else:
            out = lama(img, mask)
            out = out.convert("RGB").crop((0, 0, w, h))

        # 残痕自检：用同一套检测跑一遍修好的图；还检得出笔画 ⇒ 没修净 ⇒ rect 兜底重修
        resid_hit = -1.0
        if a.selfcheck == "1" and info["ok"] and info["hit"] > 0:
            resid = detect_glyph(out, roi, a.sat)
            resid_hit = resid["hit"]
            alarm = max(SELF_CHECK_FLOOR, SELF_CHECK_RATIO * info["hit"])
            if resid["hit"] >= alarm:
                print(f"[wm_lama] {name}: 残痕自检未过（残留 {resid['hit']:.2%} ≥ 阈值 "
                      f"{alarm:.2%}，原命中 {info['hit']:.2%}）⇒ 改用 rect 重修", flush=True)
                out = lama(img, build_rect_mask(w, h, roi)).convert("RGB").crop((0, 0, w, h))
                used = "rect"
                degraded = degraded or "selfcheck"
                note += f"＋自检未过（残留 {resid['hit']:.2%}）→rect 兜底"
            else:
                note += f"＋自检通过（残留 {resid['hit']:.2%}）"

        # 常驻度量：日志里自证「走了哪条路、改了多少、有没有渗出 ROI」
        st = area_stats(img, out, roi)
        used_hist[used] = used_hist.get(used, 0) + 1
        if degraded:
            degraded_n += 1
        roi_pcts.append(st["roi_pct"])
        if st["outside_px"] > 0:
            outside_total += st["outside_px"]
        print(
            "[wm_lama][metrics] "
            f"name={name} requested={requested} used={used} degraded={degraded or 'none'} "
            f"hit={info['hit']:.4f} residual={resid_hit:.4f} "
            f"roi_changed={st['roi_pct']:.2f} outside_px={st['outside_px']} "
            f"mean_abs={st['mean_abs']:.2f}",
            flush=True,
        )

        stem = os.path.splitext(name)[0]
        out.save(os.path.join(a.dst, stem + ".png"))
        n += 1
        print(f"[wm_lama] {name} -> {stem}.png  [{note}]", flush=True)

    if roi_pcts:
        print(
            "[wm_lama][metrics-summary] "
            f"n={n} tight={used_hist.get('tight', 0)} rect={used_hist.get('rect', 0)} "
            f"degraded={degraded_n} roi_changed_mean={sum(roi_pcts) / len(roi_pcts):.2f} "
            f"roi_changed_max={max(roi_pcts):.2f} outside_px={outside_total}",
            flush=True,
        )
    print(f"[wm_lama] done {n}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
