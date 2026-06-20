#!/usr/bin/env python3
"""元絵に対し、抽出パーツをマスク付き正規化相互相関(NCC)で位置合わせする。
パーツは緑シート由来で別生成のため完全一致はしないが、最尤位置・スケールを推定する。
Padfield(2010) のマスク付きNCCをscipyのFFT相関で実装。
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.signal import fftconvolve

ORIG = Path("../../Gemini_Generated_Image_1dshow1dshow1dsh.png")
PARTS = Path("../assets/parts")
MW = 1024                      # マッチング解像度
EPS = 1e-6

orig = Image.open(ORIG).convert("L")
ORIG_FULL = orig.size[0]       # 2048 (正方形前提)
fo = MW / ORIG_FULL
of = np.asarray(orig.resize((MW, MW)), dtype=np.float64)

# 元絵の自乗（前計算）
of2 = of * of


def masked_ncc(img, img2, tpl, msk):
    """img(2D), img2=img^2, tpl(2D, masked region values), msk(0/1) -> NCC map (valid)."""
    tf = tpl[::-1, ::-1].copy()
    mf = msk[::-1, ::-1].copy()
    n = msk.sum()
    sum_t = (tpl * msk).sum()
    sum_t2 = (tpl * tpl * msk).sum()
    corr_fm = fftconvolve(img, mf, mode="valid")
    corr_f2m = fftconvolve(img2, mf, mode="valid")
    corr_ft = fftconvolve(img, (tpl * msk)[::-1, ::-1], mode="valid")
    num = corr_ft - corr_fm * sum_t / n
    den_f = np.sqrt(np.clip(corr_f2m - corr_fm ** 2 / n, 0, None))
    den_t = np.sqrt(max(sum_t2 - sum_t ** 2 / n, 0))
    ncc = num / (den_f * den_t + EPS)
    return ncc


def match_part(index, scales):
    p = Image.open(PARTS / f"part_{index:02d}.png").convert("RGBA")
    arr = np.asarray(p)
    best = None
    for s in scales:
        # full-orig上でのパーツ寸法 = sheet寸法 * s、マッチング解像度では *fo
        f = s * fo
        nw, nh = max(8, int(p.width * f)), max(8, int(p.height * f))
        if nw >= MW or nh >= MW:
            continue
        pr = p.resize((nw, nh))
        a = np.asarray(pr)
        gray = np.asarray(Image.fromarray(a[:, :, :3]).convert("L"), dtype=np.float64)
        msk = (a[:, :, 3] > 40).astype(np.float64)
        if msk.sum() < 30:
            continue
        ncc = masked_ncc(of, of2, gray, msk)
        yx = np.unravel_index(np.argmax(ncc), ncc.shape)
        score = float(ncc[yx])
        # 元絵フル座標での中心
        cx = (yx[1] + nw / 2) / fo
        cy = (yx[0] + nh / 2) / fo
        if best is None or score > best["score"]:
            best = {"index": index, "scale": round(s, 3), "score": round(score, 4),
                    "cx": round(cx, 1), "cy": round(cy, 1)}
    return best


if __name__ == "__main__":
    idxs = [int(x) for x in sys.argv[1:]] or [19]
    scales = [round(x, 3) for x in np.arange(1.2, 2.41, 0.1)]
    for ix in idxs:
        print(match_part(ix, scales))
