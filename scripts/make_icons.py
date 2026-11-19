#!/usr/bin/env python3
"""Generate the PWA/app icons from the same open-book mark as icon.svg.

Run with the bundled Python (Pillow is available there):
    python3 scripts/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SS = 4  # supersample factor for clean edges

BG_TOP = (27, 39, 51)
BG_BOTTOM = (11, 16, 22)
AMBER_TOP = (255, 180, 84)
AMBER_BOTTOM = (255, 143, 63)
SPINE = (18, 26, 34)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def bg_gradient(size):
    img = Image.new("RGB", (size, size), BG_TOP)
    draw = ImageDraw.Draw(img)
    for y in range(size):
        draw.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / max(1, size - 1)))
    return img


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    s = size * SS
    radius = 0 if maskable else round(s * 0.22)

    base = bg_gradient(s).convert("RGBA")

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)

    # Vertical amber gradient for the page shapes.
    amber = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    adraw = ImageDraw.Draw(amber)
    for y in range(s):
        adraw.line(
            [(0, y), (s, y)],
            fill=lerp(AMBER_TOP, AMBER_BOTTOM, y / max(1, s - 1)) + (255,),
        )

    glyph = Image.new("L", (s, s), 0)
    gd = ImageDraw.Draw(glyph)

    # Design box in 0..100 units; maskable keeps a 76% safe area for launchers.
    if maskable:
        lo, hi, top, bottom = 26.0, 74.0, 30.0, 70.0
        spine_w = 2.6
    else:
        lo, hi, top, bottom = 17.0, 83.0, 23.0, 79.0
        spine_w = 3.0

    cx = 50.0
    crest = top + 6.0  # pages dip at the spine

    def px(v):
        return v / 100.0 * s

    left = [(cx, crest), (lo, top + 3.5), (lo, bottom - 6.0), (cx, bottom)]
    right = [(cx, crest), (hi, top + 3.5), (hi, bottom - 6.0), (cx, bottom)]

    gd.polygon([(px(x), px(y)) for x, y in left], fill=255)
    gd.polygon([(px(x), px(y)) for x, y in right], fill=255)

    # Cut the spine back out so the mark reads as two pages.
    gd.line([(px(cx), px(crest)), (px(cx), px(bottom))], fill=0, width=round(px(spine_w)))

    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(amber, (0, 0), glyph)

    composed = Image.alpha_composite(base, icon)
    composed.putalpha(mask)

    return composed.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    targets = {
        "icon-180.png": (180, False),
        "icon-192.png": (192, False),
        "icon-512.png": (512, False),
        "icon-maskable.png": (512, True),
    }
    for name, (size, maskable) in targets.items():
        draw_icon(size, maskable).save(OUT / name, "PNG", optimize=True)
        print(f"wrote {OUT / name}")


if __name__ == "__main__":
    main()
