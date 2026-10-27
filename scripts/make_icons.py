#!/usr/bin/env python3
"""Render the Hearth flame icons (needs Pillow). Run: python3 scripts/make_icons.py"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

OUTER = [  # cubic segments in unit coords: (p0, c1, c2, p3)
    ((0.53, 0.14), (0.58, 0.30), (0.76, 0.40), (0.76, 0.60)),
    ((0.76, 0.60), (0.76, 0.76), (0.64, 0.86), (0.50, 0.86)),
    ((0.50, 0.86), (0.36, 0.86), (0.24, 0.76), (0.24, 0.61)),
    ((0.24, 0.61), (0.24, 0.48), (0.31, 0.42), (0.36, 0.33)),
    ((0.36, 0.33), (0.38, 0.43), (0.42, 0.47), (0.455, 0.47)),
    ((0.455, 0.47), (0.43, 0.33), (0.47, 0.22), (0.53, 0.14)),
]
INNER = [
    ((0.50, 0.45), (0.54, 0.56), (0.63, 0.60), (0.63, 0.70)),
    ((0.63, 0.70), (0.63, 0.77), (0.57, 0.81), (0.50, 0.81)),
    ((0.50, 0.81), (0.43, 0.81), (0.37, 0.77), (0.37, 0.70)),
    ((0.37, 0.70), (0.37, 0.60), (0.46, 0.56), (0.50, 0.45)),
]


def bez(seg, n=40):
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = seg
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u**3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x3,
                    u**3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y3))
    return pts


def poly(segs, size):
    pts = []
    for s in segs:
        pts.extend(bez(s))
    return [(x * size, y * size) for x, y in pts]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def vertical(size, top, bottom):
    im = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(im)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bottom, y / (size - 1)))
    return im


def render(px):
    s = px * 4  # supersample
    # Diagonal navy -> plum background.
    bg = Image.new("RGBA", (s, s))
    navy, plum = (14, 18, 44, 255), (92, 40, 96, 255)
    small = Image.new("RGBA", (64, 64))
    for y in range(64):
        for x in range(64):
            small.putpixel((x, y), lerp(navy, plum, min(1, (x + y) / 126 * 1.1)))
    bg = small.resize((s, s), Image.BICUBIC)

    # Warm glow behind the flame.
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = s * 0.30
    gd.ellipse([s * 0.5 - r, s * 0.6 - r, s * 0.5 + r, s * 0.6 + r], fill=(255, 140, 60, 90))
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.08))
    bg = Image.alpha_composite(bg, glow)

    outer_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(outer_mask).polygon(poly(OUTER, s), fill=255)
    outer = vertical(s, (255, 84, 54, 255), (255, 160, 64, 255))
    bg.paste(outer, (0, 0), outer_mask)

    inner_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(inner_mask).polygon(poly(INNER, s), fill=255)
    inner = vertical(s, (255, 214, 120, 255), (255, 246, 205, 255))
    bg.paste(inner, (0, 0), inner_mask)

    return bg.resize((px, px), Image.LANCZOS).convert("RGB")


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, px in [("icon-512.png", 512), ("icon-192.png", 192),
                     ("apple-touch-icon.png", 180), ("favicon-32.png", 32)]:
        render(px).save(os.path.join(OUT, name), optimize=True)
        print("wrote", name)


if __name__ == "__main__":
    main()
