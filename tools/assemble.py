#!/usr/bin/env python3
"""layout.json を読み、抽出パーツを中心座標+z順で合成してプレビューを出力。
パーツは同一シート由来=同一スケールなので、配置は平行移動とz順のみ。
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

PARTS = Path("../assets/parts")
LAYOUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("layout.json")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/assembled.png")

cfg = json.loads(LAYOUT.read_text())
W, H = cfg["canvas"]
canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))

# z昇順で奥から重ねる
for item in sorted(cfg["parts"], key=lambda p: p["z"]):
    if item.get("hidden"):
        continue
    im = Image.open(PARTS / f"part_{item['index']:02d}.png").convert("RGBA")
    if item.get("flip"):
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    cx, cy = item["cx"], item["cy"]
    x = int(cx - im.width / 2)
    y = int(cy - im.height / 2)
    canvas.alpha_composite(im, (x, y))

# 確認用: 緑下地に乗せた版も出す（透過部の把握用）
preview = Image.new("RGBA", (W, H), (120, 130, 140, 255))
preview.alpha_composite(canvas)
preview.convert("RGB").save(OUT)
canvas.save(str(OUT).replace(".png", "_rgba.png"))
print("assembled ->", OUT)
