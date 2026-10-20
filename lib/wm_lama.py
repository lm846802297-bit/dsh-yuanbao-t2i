# -*- coding: utf-8 -*-
"""wm_lama.py — LaMa 引擎去水印（simple-lama-inpainting，GPU/CPU 自适应）。
用法：python wm_lama.py --src <目录> --dst <目录> --roi x0,y0,x1,y1 [--device cuda]
掩膜 = ROI 白色矩形（整块区域交给 LaMa 重建，质量优于 TELEA 但更慢）。
"""
import argparse, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--roi", required=True, help="x0,y0,x1,y1 相对比例")
    ap.add_argument("--device", default=None, help="cuda / cpu（默认自动）")
    a = ap.parse_args()

    x0, y0, x1, y1 = (float(v) for v in a.roi.split(","))
    os.makedirs(a.dst, exist_ok=True)

    from simple_lama_inpainting import SimpleLama
    from PIL import Image
    import numpy as np

    device = a.device or ("cuda" if __import__("torch").cuda.is_available() else "cpu")
    print(f"[wm_lama] device={device}", flush=True)
    lama = SimpleLama(device=device)

    exts = (".png", ".jpg", ".jpeg", ".webp")
    n = 0
    for name in sorted(os.listdir(a.src)):
        if not name.lower().endswith(exts) or name.startswith("_"):
            continue
        img = Image.open(os.path.join(a.src, name)).convert("RGB")
        w, h = img.size
        mask = Image.new("L", (w, h), 0)
        px = np.zeros((h, w), dtype=np.uint8)
        px[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)] = 255
        mask = Image.fromarray(px)
        out = lama(img, mask)
        stem = os.path.splitext(name)[0]
        out.save(os.path.join(a.dst, stem + ".png"))
        n += 1
        print(f"[wm_lama] {name} -> {stem}.png", flush=True)
    print(f"[wm_lama] done {n}", flush=True)

if __name__ == "__main__":
    main()
