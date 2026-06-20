#!/usr/bin/env python3
"""緑背景のパーツシートから、各パーツを透過PNGに切り出す。

- 緑クロマキーでアルファ生成
- 連結成分ラベリングでパーツごとに分割
- 緑スピル(縁の緑かぶり)除去
- 個別PNG + manifest.json + 確認用オーバービュー(overview.png)を出力
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("../../ChatGPT Image 2026年6月16日 22_56_20.png")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("../assets/parts")
OUT.mkdir(parents=True, exist_ok=True)

im = Image.open(SRC).convert("RGB")
a = np.array(im).astype(int)
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
H, W = r.shape

# --- 緑背景マスク（緑が赤青より十分大きい） ---
bg = (g - np.maximum(r, b) > 25) & (g > 90)
fg = ~bg

# --- ノイズ除去：小穴埋め＋微小スペック除去 ---
fg = ndimage.binary_closing(fg, iterations=2)
fg = ndimage.binary_opening(fg, iterations=1)
fg = ndimage.binary_fill_holes(fg)

# --- 連結成分ラベリング ---
labels, n = ndimage.label(fg)
sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
MIN_AREA = int(0.0008 * H * W)  # ~1250px 未満は捨てる
objects = ndimage.find_objects(labels)

# --- 緑スピル除去用：g を max(r,b) に丸める（緑以外は不変） ---
rgb = np.array(im).astype(np.uint8)

manifest = []
overview = im.copy()
draw = ImageDraw.Draw(overview)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 28)
except Exception:
    font = ImageFont.load_default()

idx = 0
for li in range(1, n + 1):
    if sizes[li - 1] < MIN_AREA:
        continue
    sl = objects[li - 1]
    y0, y1 = sl[0].start, sl[0].stop
    x0, x1 = sl[1].start, sl[1].stop
    pad = 4
    y0, x0 = max(0, y0 - pad), max(0, x0 - pad)
    y1, x1 = min(H, y1 + pad), min(W, x1 + pad)

    region_mask = (labels[y0:y1, x0:x1] == li)
    crop = rgb[y0:y1, x0:x1].copy()

    # 縁の緑スピル除去
    gg = crop[:, :, 1].astype(int)
    cap = np.maximum(crop[:, :, 0], crop[:, :, 2]).astype(int)
    spill = gg > cap
    crop[:, :, 1] = np.where(spill, cap, gg).astype(np.uint8)

    alpha = (region_mask * 255).astype(np.uint8)
    # アルファを1px縮めて緑縁を残さない
    alpha = (ndimage.binary_erosion(region_mask, iterations=1) * 255).astype(np.uint8)

    rgba = np.dstack([crop, alpha])
    part = Image.fromarray(rgba, "RGBA")
    fname = f"part_{idx:02d}.png"
    part.save(OUT / fname)

    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    manifest.append({
        "index": idx, "file": fname,
        "bbox": [int(x0), int(y0), int(x1 - x0), int(y1 - y0)],
        "center": [int(cx), int(cy)], "area": int(sizes[li - 1]),
        "sheet_size": [W, H], "name": None,
    })

    draw.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=3)
    draw.text((x0 + 4, y0 + 2), str(idx), fill=(255, 0, 0), font=font)
    idx += 1

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
overview.save(OUT / "overview.png")
print(f"extracted {idx} parts -> {OUT}")
print("MIN_AREA =", MIN_AREA)
for m in manifest:
    print(m["index"], m["bbox"], "area", m["area"])
