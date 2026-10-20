# -*- coding: utf-8 -*-
"""test-mask-gates.py — 去水印「掩膜检测」闸门测试（纯函数，不加载 LaMa、不联网）。

为什么需要它：v0.9.0 及以前的检测口径有真 bug —— 取 ROI 亮度分位数两端、挑「命中面积更小」
的一端，结果 3/8 张真样本选中端命中率只有 0.65% / 0.07% / 0.00%，掩膜近空 ⇒ 水印原样留着，
不报错、不降级。这类失败是**静默**的：语法合法、运行不报错、只是事情没做成。
⇒ 用合成图把「该降级时降级、该精确时精确」逐条钉死。

依赖：numpy + Pillow（CI 里由 `pip install numpy pillow` 提供；本地用装了 numpy 的解释器，
例如 DSH_LAMA_PYTHON 或 C:/Users/84680/.workbuddy/binaries/python/envs/default/Scripts/python.exe）。

用法：python scripts/ci/test-mask-gates.py   （退出码 0=全过，1=有失败）
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))          # scripts/ci → scripts → 仓库根
TARGET = os.path.join(REPO, "lib", "wm_lama.py")

ROI = (0.71, 0.878, 0.992, 0.996)                      # 元宝水印 ROI（与插件默认一致）
SZ = (1600, 900)

fails = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  {extra}" if extra else ""))
    if not cond:
        fails.append(name)


def strip_comments_and_docstrings(src):
    """粗略剥掉 `#` 注释与三引号块，只留「可执行代码」——静态扫描注释会误报。"""
    out, i, n = [], 0, len(src)
    quote = None
    while i < n:
        if quote:
            j = src.find(quote, i)
            if j < 0:
                i = n
                break
            i = j + 3
            quote = None
            continue
        if src.startswith('"""', i) or src.startswith("'''", i):
            quote = src[i:i + 3]
            i += 3
            continue
        ch = src[i]
        if ch == "#":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def load():
    spec = importlib.util.spec_from_file_location("wm_lama", TARGET)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def glyph_patch(mod, img, fill, box_xy):
    """在 img 上画假水印；box_xy 是 (x, y)（像素，已落在 PRIOR_BOX 内）。"""
    from PIL import ImageDraw, ImageFont

    try:
        font = ImageFont.load_default(size=44)
    except Exception:                                   # Pillow < 10.1 没有 size 参数
        font = ImageFont.load_default()
    ImageDraw.Draw(img).text(box_xy, "元宝\nAI生成", fill=fill, font=font)


def prior_xy(mod, img):
    """算一个落在 PRIOR_BOX 内的落点（否则合成水印会被位置先验正确地过滤掉）。"""
    w, h = img.size
    rx0, ry0 = int(ROI[0] * w), int(ROI[1] * h)
    rw, rh = int(ROI[2] * w) - rx0, int(ROI[3] * h) - ry0
    return rx0 + int(0.66 * rw), ry0 + int(0.55 * rh)


def main():
    try:
        import numpy as np
        from PIL import Image
    except Exception as e:                              # noqa: BLE001
        print(f"  FAIL 环境缺依赖：{e}")
        print("       CI：pip install numpy pillow ／ 本地：跑 env_doctor 找装了 numpy 的解释器")
        return 1

    if not os.path.exists(TARGET):
        print(f"  FAIL 找不到 {TARGET}")
        return 1
    wm = load()
    print(f"==> 掩膜闸门测试（{os.path.relpath(TARGET, REPO)}）")

    # ── 1. 纯白无水印：命中率 0 < MIN_HIT ⇒ 必须判「检测失效」并降级 rect
    blank = Image.new("RGB", SZ, (255, 255, 255))
    m, note, info = wm.build_tight_mask(blank, ROI, None, 45, 25)
    check("纯白图判检测失效→rect", info["ok"] is False and "降级 rect" in note,
          f"hit={info['hit']:.4f}")

    # ── 2. 纯噪声：不该被当成字形（MIN/MAX 闸至少要拦下一种）
    rng = np.random.default_rng(0)
    noise = Image.fromarray(rng.integers(0, 256, (SZ[1], SZ[0], 3), dtype=np.uint8))
    m, note, info = wm.build_tight_mask(noise, ROI, None, 45, 25)
    check("纯噪声判不可信→rect", info["ok"] is False and "降级 rect" in note,
          f"hit={info['hit']:.2%}")

    # ── 3. 白底 + 浅灰水印（在 PRIOR_BOX 内）：必须走 tight，命中率落可信带
    img = Image.new("RGB", SZ, (250, 250, 248))
    glyph_patch(wm, img, (205, 205, 205), prior_xy(wm, img))
    m, note, info = wm.build_tight_mask(img, ROI, None, 45, 25)
    check("合成水印走 tight", info["ok"] is True and info["hit"] > wm.MIN_HIT,
          f"hit={info['hit']:.2%}")
    check("命中率不超上限", info["hit"] < wm.MAX_HIT, f"hit={info['hit']:.2%}")

    # ── 4. 暗底 + 亮水印：同一套口径也要能检（旧实现靠「亮/暗两端二选一」，已废）
    img2 = Image.new("RGB", SZ, (28, 28, 32))
    glyph_patch(wm, img2, (232, 232, 232), prior_xy(wm, img2))
    m, note, info = wm.build_tight_mask(img2, ROI, None, 45, 25)
    check("暗底亮字也能检（不靠亮暗分支）", info["ok"] is True and info["hit"] > wm.MIN_HIT,
          f"hit={info['hit']:.2%}")

    # ── 5. 位置先验真的在起作用：把同样强度的假水印画到 ROI 左半边 ⇒ 不该检出
    img3 = Image.new("RGB", SZ, (250, 250, 248))
    glyph_patch(wm, img3, (205, 205, 205), (int(0.715 * SZ[0]) + 6, int(0.885 * SZ[1]) + 6))
    m, note, info = wm.build_tight_mask(img3, ROI, None, 45, 25)
    check("PRIOR_BOX 外的假水印不被检出", info["ok"] is False,
          f"hit={info['hit']:.2%}（应判失效）")

    # ── 6. 非法 ROI（x0>x1，来自 wmRoi 参数或 DSH_WM_ROI 传反）不许崩
    for bad in [(0.9, 0.9, 0.8, 0.8), (0.99, 0.99, 0.999, 0.999), (-1, -1, 2, 2)]:
        try:
            mb = wm.build_rect_mask(SZ[0], SZ[1], bad)
            ok = mb.size == SZ and mb.getbbox() is not None
            check(f"非法 ROI 不崩 {bad}", ok, str(mb.getbbox()))
        except Exception as e:                          # noqa: BLE001
            check(f"非法 ROI 不崩 {bad}", False, f"{type(e).__name__}: {e}")

    # ── 7. 旧固定阈值分支仍在（--thr 显式覆盖路径不能被删）
    img4 = Image.new("RGB", SZ, (30, 30, 30))
    glyph_patch(wm, img4, (250, 250, 250), prior_xy(wm, img4))
    m, note, info = wm.build_tight_mask(img4, ROI, 200, 45, 25)
    check("--thr 固定阈值分支可用", "thr=200" in note and info["ok"] is True, note[:60])

    # ── 8. 检测口径不许退回旧 bug：**可执行代码**里不能出现分位数两端二选一
    #    ⚠️ 只扫代码不扫注释/文档串：模块 docstring 里正解释着「旧实现用 p99.5/p0.5」，
    #    整文件搜字符串会把这段说明判红（假阳性），所以先剥注释与三引号块。
    raw = open(TARGET, encoding="utf-8").read()
    code = strip_comments_and_docstrings(raw)
    banned = [t for t in ("percentile", "p99.5", "p0.5", "亮笔画", "暗笔画") if t in code]
    check("源码无旧分位数口径残留", not banned,
          ("命中：" + ",".join(banned)) if banned else "")

    # ── 9. 常量存在性（闸门/自检不许被删）
    for name in ("MIN_HIT", "MAX_HIT", "SELF_CHECK_RATIO", "PRIOR_BOX", "MED_K"):
        check(f"常量 {name} 存在", hasattr(wm, name))

    print()
    if fails:
        print(f"掩膜闸门：{len(fails)} 项 FAIL → {fails}")
        return 1
    print("掩膜闸门：全部 PASS")
    return 0


if __name__ == "__main__":
    # ⚠️ 别让 API 漂移以 traceback 收场：旧版 build_tight_mask 返回 2 元组而不是
    # (mask, note, info)，解包会抛 ValueError —— 那是「被测代码不符合契约」，
    # 必须报成一条 FAIL（红），而不是让测试自己崩掉（崩掉看起来像测试环境问题）。
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:                              # noqa: BLE001
        print(f"  FAIL 契约不符/测试中断：{type(e).__name__}: {e}")
        print("       多半是被测 lib/wm_lama.py 的接口变了（build_tight_mask 须返回 (mask, note, info)）")
        sys.exit(1)
