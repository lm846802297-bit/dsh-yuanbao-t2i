# -*- coding: utf-8 -*-
"""wm_lama.py — LaMa 引擎去水印（simple-lama-inpainting，GPU/CPU 自适应）。

用法：
  python wm_lama.py --src <目录> --dst <目录> --roi x0,y0,x1,y1 [--mask rect|tight] [--device cuda]

掩膜模式：
  rect  （默认）ROI 整块白矩形交给 LaMa 重建 —— 最稳、但重修面积大，插画类会「糊一片」。
  tight 在 ROI 内按「近白 + 低饱和」阈值检出字形，膨胀成紧贴字形的掩膜后再修 ——
        重修面积小得多、痕更轻；白底/亮背景可能误遮，检出为空时自动回退 rect。

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
    """在 ROI 内检出近白低饱和的字形像素，膨胀成掩膜。返回 (mask, 说明)。"""
    import numpy as np
    from PIL import Image, ImageFilter

    w, h = img.size
    x0, y0, x1, y1 = int(roi[0] * w), int(roi[1] * h), int(roi[2] * w), int(roi[3] * h)
    if x1 <= x0 or y1 <= y0:
        return build_rect_mask(w, h, roi), "ROI 非法，回退 rect"

    sub = np.asarray(img.crop((x0, y0, x1, y1))).astype(np.int16)
    mx = sub.max(axis=2)
    mn = sub.min(axis=2)
    glyph = ((mx > thr) & ((mx - mn) < sat)).astype(np.uint8) * 255
    if glyph.sum() == 0:
        return build_rect_mask(w, h, roi), f"ROI 内未检出字形（thr={thr} sat={sat}），回退 rect"

    mask = Image.fromarray(glyph)
    # PIL 的 MaxFilter 只吃小核，重复几次累计膨胀（9 核≈每边 +4px，7 次≈28px，够包住字边）
    if dilate > 0:
        steps = max(1, round(dilate / 4))
        for _ in range(steps):
            mask = mask.filter(ImageFilter.MaxFilter(9))
    full = Image.new("L", (w, h), 0)
    full.paste(mask, (x0, y0))
    return full, f"字形掩膜 thr={thr} sat={sat} dilate≈{dilate}px"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--roi", required=True, help="x0,y0,x1,y1 相对比例")
    ap.add_argument("--mask", default="rect", choices=["rect", "tight"], help="掩膜模式")
    ap.add_argument("--thr", type=int, default=185, help="tight：近白阈值（0-255）")
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
