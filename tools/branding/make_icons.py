"""Generate the placeholder brand icons into branding/overlay/.

The mark: a dawn-gradient disc (coral -> violet -> deep blue) with two calm wave lines.
It is a placeholder until the final name and identity are chosen; rerun after changing COLORS.

Usage:  python3 tools/branding/make_icons.py        (needs Pillow)
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "branding" / "overlay"

TOP = (255, 138, 101)      # coral
MID = (140, 92, 230)       # violet
BOTTOM = (40, 52, 140)     # deep blue
WAVE = (255, 255, 255)

SS = 4  # supersampling factor for smooth edges


def _lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        color = _lerp(TOP, MID, t / 0.55) if t < 0.55 else _lerp(MID, BOTTOM, (t - 0.55) / 0.45)
        for x in range(size):
            px[x, y] = color
    return img


def _wave_points(size: int, cy: float, amp: float, x0: float, x1: float, steps: int = 64):
    pts = []
    for i in range(steps + 1):
        x = x0 + (x1 - x0) * i / steps
        phase = (x - x0) / (x1 - x0) * 2 * math.pi
        pts.append((x, cy + math.sin(phase) * amp))
    return pts


def mark(px_size: int, private: bool = False) -> Image.Image:
    """Render the mark at px_size x px_size with transparency."""
    s = px_size * SS
    grad = _gradient(s)
    if private:  # private-browsing variant: cooler, darker
        grad = Image.blend(grad, Image.new("RGB", (s, s), (30, 20, 70)), 0.45)
    mask = Image.new("L", (s, s), 0)
    inset = s * 0.04
    ImageDraw.Draw(mask).ellipse((inset, inset, s - inset, s - inset), fill=255)

    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)

    # Waves are simplified away at tiny sizes so the icon stays crisp.
    # (one wave at <=24 px, two above)
    width = max(SS * 1, round(s * (0.07 if px_size <= 24 else 0.055)))
    waves = [(0.56, 0.045)] if px_size <= 24 else [(0.52, 0.04), (0.68, 0.035)]
    # Stroke with a round brush (dense dabs) on a separate layer: smooth, artifact-free curves.
    layer = Image.new("L", (s, s), 0)
    brush = ImageDraw.Draw(layer)
    r = width / 2
    for cy, amp in waves:
        for x, y in _wave_points(s, s * cy, s * amp, s * 0.24, s * 0.76, steps=s):
            brush.ellipse((x - r, y - r, x + r, y + r), fill=235)
    white = Image.new("RGBA", (s, s), WAVE + (255,))
    white.putalpha(layer)
    out.alpha_composite(white)
    # Keep waves inside the disc.
    alpha = Image.composite(out.getchannel("A"), Image.new("L", (s, s), 0), mask)
    out.putalpha(alpha)
    return out.resize((px_size, px_size), Image.LANCZOS)


def tile(px_w: int, px_h: int, mark_frac: float, bg=(28, 24, 48), private=False) -> Image.Image:
    """Windows start-menu tile: mark centred on a solid background."""
    img = Image.new("RGBA", (px_w, px_h), bg + (255,))
    m = mark(round(min(px_w, px_h) * mark_frac), private)
    img.alpha_composite(m, ((px_w - m.width) // 2, (px_h - m.height) // 2))
    return img


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb{top}"/>
      <stop offset="0.55" stop-color="rgb{mid}"/>
      <stop offset="1" stop-color="rgb{bottom}"/>
    </linearGradient>
  </defs>
  <circle cx="128" cy="128" r="118" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-opacity="0.92" stroke-width="14" stroke-linecap="round">
    <path d="M61 133 C 87 103, 113 103, 128 133 S 169 163, 195 133"/>
    <path d="M61 174 C 87 148, 113 148, 128 174 S 169 200, 195 174"/>
  </g>
</svg>
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "content").mkdir(exist_ok=True)

    for size in (16, 22, 24, 32, 48, 64, 128, 256):
        mark(size).save(OUT / f"default{size}.png")

    content = OUT / "content"
    mark(192).save(content / "about-logo.png")
    mark(384).save(content / "about-logo@2x.png")
    mark(192, private=True).save(content / "about-logo-private.png")
    mark(384, private=True).save(content / "about-logo-private@2x.png")
    mark(64).save(content / "about.png")
    svg = SVG.format(top=TOP, mid=MID, bottom=BOTTOM)
    (content / "about-logo.svg").write_text(svg, encoding="utf-8")

    tile(150, 150, 0.6).save(OUT / "VisualElements_150.png")
    tile(70, 70, 0.6).save(OUT / "VisualElements_70.png")
    tile(150, 150, 0.6, private=True).save(OUT / "PrivateBrowsing_150.png")
    tile(70, 70, 0.6, private=True).save(OUT / "PrivateBrowsing_70.png")

    # Windows installer (NSIS) art: 24-bit BMPs at the sizes the installer expects.
    header = Image.new("RGB", (150, 57), (255, 255, 255))
    m = mark(44)
    header.paste(m, (150 - 44 - 7, 6), m)
    header.save(OUT / "wizHeader.bmp")
    header.transpose(Image.FLIP_LEFT_RIGHT).save(OUT / "wizHeaderRTL.bmp")
    side = _gradient(314).resize((164, 314)).convert("RGBA")
    side = Image.blend(side, Image.new("RGBA", side.size, (20, 18, 40, 255)), 0.35)
    m = mark(96)
    side.alpha_composite(m, ((164 - 96) // 2, 70))
    side.convert("RGB").save(OUT / "wizWatermark.bmp")

    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    big = mark(256)
    big.save(OUT / "firefox.ico", sizes=ico_sizes)
    big.save(OUT / "firefox64.ico", sizes=[(64, 64)])
    mark(256, private=True).save(OUT / "pbmode.ico", sizes=ico_sizes)
    mark(1024).save(OUT / "firefox.icns")
    print(f"Icons written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
