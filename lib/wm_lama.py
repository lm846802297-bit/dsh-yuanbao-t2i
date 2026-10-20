# -*- coding: utf-8 -*-
"""wm_lama.py — LaMa 引擎去水印（simple-lama-inpainting，GPU/CPU 自适应）。

用法：
  python wm_lama.py --src <目录> --dst <目录> --roi x0,y0,x1,y1 [--mask rect|tight] [--device cuda]

掩膜模式：
  rect  ROI 整块白矩形交给 LaMa 重建 —— 最稳、但重修面积大，插画类会「糊一片」。
  tight （插件默认）在 ROI 内检出字形，膨胀成紧贴字形的掩膜后再修 —— 重修面积小得多、痕更轻。

    元宝水印是半透明白叠加：暗背景上是**亮笔画**，白背景上是**暗笔画**（只比纸暗 3-9 级）。
    固定绝对阈值必然一头踩空（thr=185 在纯白图上命中 100%＝把整块背景当字形抹平），
    所以 tight 默认走**自适应**：阈值由 ROI 自身亮度分布导出，两端都试，取命中面积更小的
    那一端（白底图自动切暗笔画、暗底图自动切亮笔画）。仍可用 --thr/--sat/--dilate 显式覆盖。
    两端命中面积都超过 ROI 的 60% ⇒ 判定「tight 不可信」，自动降级 rect 并打印原因。

tight 的上下文：以掩膜外接框外扩 --ctx 像素裁切，只把这块送进模型，回填时按羽化掩膜混合，
避免接缝。
"""
import argparse
import os


def build_rect_mask(w, h, roi):
    from PIL import Image

    x0, y0, x1, y1 = roi
    px = Image.new("L", (w, h), 0)
    from PIL import ImageDraw

    ImageDraw.Draw(px).rectangle(
        [int(x0 * w), int(y0 * h), int(x1 * w) - 1, int(y1 * h) - 1], fill=255
    )
    return px


def build_tight_mask(img, roi, thr, sat, dilate):
    """在 ROI 内检出字形像素，膨胀成掩膜。返回 (mask, 说明)。

    thr=None 时走自适应：元宝水印是半透明白叠加，暗底上是亮笔画、白底上是暗笔画。
    固定绝对阈值会一头踩空 ⇒ 阈值改由 ROI 自身亮度分布导出，两端都检，取命中面积小的一端。
    """
    import numpy as np
    from PIL import Image, ImageFilter

    w, h = img.size
    x0, y0, x1, y1 = int(roi[0] * w), int(roi[1] * h), int(roi[2] * w), int(roi[3] * h)
    if x1 <= x0 or y1 <= y0:
        return build_rect_mask(w, h, roi), "ROI 非法，回退 rect"

    sub = np.asarray(img.crop((x0, y0, x1, y1))).astype(np.int16)
    mx = sub.max(axis=2)
    mn = sub.min(axis=2)
    lowsat = (mx - mn) < sat

    if thr is None:
        # 自适应：两端各出一个候选掩膜，取命中面积更小的一端
        lum = sub.mean(axis=2)
        p_hi = float(np.percentile(lum, 99.5))
        p_lo = float(np.percentile(lum, 0.5))
        bright = ((lum > p_hi - 12) & lowsat).astype(np.uint8) * 255
        dark = ((lum < p_lo + 12) & lowsat).astype(np.uint8) * 255
        nb, nd = int((bright > 0).sum()), int((dark > 0).sum())
        total = sub.shape[0] * sub.shape[1]
        # 两端都糊掉大半 ⇒ ROI 里没有可分离的字形，别硬修
        if nb > 0.6 * total and nd > 0.6 * total:
            return build_rect_mask(w, h, roi), (
                f"两端检出面积均超 ROI 60%（亮 {nb / total:.0%} / 暗 {nd / total:.0%}），"
                "ROI 内无可分离字形，回退 rect"
            )
        if nd == 0 and nb == 0:
            return build_rect_mask(w, h, roi), "自适应两端均未检出字形，回退 rect"
        if nd < nb:
            glyph, note = dark, f"暗笔画 p0.5+12={p_lo + 12:.0f} 命中 {nd / total:.1%}（亮端 {nb / total:.1%}）"
        else:
            glyph, note = bright, f"亮笔画 p99.5-12={p_hi - 12:.0f} 命中 {nb / total:.1%}（暗端 {nd / total:.1%}）"
    else:
        glyph = ((mx > thr) & lowsat).astype(np.uint8) * 255
        if glyph.sum() == 0:
            return build_rect_mask(w, h, roi), f"ROI 内未检出字形（thr={thr} sat={sat}），回退 rect"
        total = sub.shape[0] * sub.shape[1]
        if int((glyph > 0).sum()) > 0.6 * total:
            return build_rect_mask(w, h, roi), (
                f"固定阈值命中面积 {int((glyph > 0).sum()) / total:.0%} 超 ROI 60%"
                "（疑似白底/亮背景误遮），回退 rect"
            )
        note = f"thr={thr} sat={sat}"

    mask = Image.fromarray(glyph)
    # PIL 的 MaxFilter 只吃小核，重复几次累计膨胀（9 核≈每边 +4px，7 次≈28px，够包住字边）
    if dilate > 0:
        steps = max(1, round(dilate / 4))
        for _ in range(steps):
            mask = mask.filter(ImageFilter.MaxFilter(9))
    full = Image.new("L", (w, h), 0)
    full.paste(mask, (x0, y0))
    return full, f"字形掩膜 {note} sat={sat} dilate≈{dilate}px"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--roi", required=True, help="x0,y0,x1,y1 相对比例")
    ap.add_argument("--mask", default="rect", choices=["rect", "tight"], help="掩膜模式")
    ap.add_argument("--thr", type=int, default=None, help="tight：近白阈值（0-255）；缺省＝按 ROI 亮度分布自适应")
    ap.add_argument("--sat", type=int, default=45, help="tight：最大通道差上限（越低越只认灰白）")
    ap.add_argument("--dilate", type=int, default=25, help="tight：掩膜膨胀半径（像素）")
    ap.add_argument("--ctx", type=int, default=160, help="tight：送模型的上下文外扩（像素）")
    ap.add_argument("--device", default=None, help="cuda / cpu（默认自动）")
    a = ap.parse_args()

    roi = tuple(float(v) for v in a.roi.split(","))
    if len(roi) != 4:
        print("[wm_lama] --roi 需要 4 个数", flush=True)
        return 2
    os.makedirs(a.dst, exist_ok=True)

    from PIL import Image, ImageFilter
    from simple_lama_inpainting import SimpleLama
    import torch

    device = a.device or ("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[wm_lama] device={device} mask={a.mask}", flush=True)
    lama = SimpleLama(device=device)

    exts = (".png", ".jpg", ".jpeg", ".webp")
    n = 0
    for name in sorted(os.listdir(a.src)):
        if not name.lower().endswith(exts) or name.startswith("_"):
            continue
        img = Image.open(os.path.join(a.src, name)).convert("RGB")
        w, h = img.size
        if a.mask == "tight":
            mask, note = build_tight_mask(img, roi, a.thr, a.sat, a.dilate)
            print(f"[wm_lama] {name}: {note}", flush=True)
        else:
            mask = build_rect_mask(w, h, roi)

        bbox = mask.getbbox()
        if a.mask == "tight" and bbox:
            # tight：只把「掩膜 + 上下文」这一块送模型，回填时按羽化掩膜混合，避免整图重建
            x0 = max(0, bbox[0] - a.ctx)
            y0 = max(0, bbox[1] - a.ctx)
            x1 = min(w, bbox[2] + a.ctx)
            y1 = min(h, bbox[3] + a.ctx)
            crop = img.crop((x0, y0, x1, y1))
            crop_mask = mask.crop((x0, y0, x1, y1))
            filled = lama(crop, crop_mask).convert("RGB")
            # SimpleLama 只往右/下 pad 到 8 的倍数，输出会比输入大几像素，裁回原尺寸
            filled = filled.crop((0, 0, crop.width, crop.height))
            soft = crop_mask.filter(ImageFilter.GaussianBlur(2.0))
            out = img.copy()
            out.paste(Image.composite(filled, crop, soft), (x0, y0))
        else:
            out = lama(img, mask)
            out = out.convert("RGB").crop((0, 0, w, h))

        stem = os.path.splitext(name)[0]
        out.save(os.path.join(a.dst, stem + ".png"))
        n += 1
        print(f"[wm_lama] {name} -> {stem}.png", flush=True)
    print(f"[wm_lama] done {n}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
