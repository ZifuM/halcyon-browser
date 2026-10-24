"""Generate Peryn's icons into branding/overlay/ from branding/logo/peryn-feather.png.

The mark: the feather (purple to sky-blue gradient, transparent background) centred on a soft
light disc. Private browsing uses the same feather on a deep indigo disc. Rerun after changing
the feather or the colours below.

Usage:  python3 tools/branding/make_icons.py        (needs Pillow)
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parents[2]
FEATHER = ROOT / "branding" / "logo" / "peryn-feather.png"
OUT = ROOT / "branding" / "overlay"

DISC_TOP, DISC_BOTTOM = (248, 249, 252), (228, 233, 241)      # light disc
PRIVATE_TOP, PRIVATE_BOTTOM = (58, 52, 104), (22, 19, 44)     # private-browsing disc
RING = (30, 38, 50, 22)                                       # faint edge, so the disc shows on white
TILE_BG = (24, 28, 36)                                        # Windows start-menu tile (slate)
PRIVATE_TILE_BG = (28, 22, 50)
DISC_INSET = 0.04      # space around the disc, as a fraction of the icon
FEATHER_SCALE = 0.70   # the feather's longest side, as a fraction of the icon
FEATHER_SCALE_SMALL = 0.78  # bigger at <= 24 px so it stays readable
SS = 4                 # supersampling for the disc edge


def _feather() -> Image.Image:
    img = Image.open(FEATHER).convert("RGBA")
    return img.crop(img.getchannel("A").getbbox())


def _disc(size: int, top, bottom) -> Image.Image:
    s = size * SS
    grad = Image.new("RGBA", (1, s))
    for y in range(s):
        t = y / max(1, s - 1)
        grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    grad = grad.resize((s, s))
    mask = Image.new("L", (s, s), 0)
    inset = s * DISC_INSET
    ImageDraw.Draw(mask).ellipse((inset, inset, s - inset, s - inset), fill=255)
    disc = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    disc.paste(grad, (0, 0), mask)
    ring = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse((inset, inset, s - inset, s - inset), outline=RING, width=max(SS, s // 128))
    disc.alpha_composite(ring)
    return disc.resize((size, size), Image.LANCZOS)


def mark(size: int, private: bool = False) -> Image.Image:
    out = _disc(size, *((PRIVATE_TOP, PRIVATE_BOTTOM) if private else (DISC_TOP, DISC_BOTTOM)))
    feather = _feather()
    scale = (FEATHER_SCALE_SMALL if size <= 24 else FEATHER_SCALE) * size / max(feather.size)
    w, h = max(1, round(feather.width * scale)), max(1, round(feather.height * scale))
    f = feather.resize((w, h), Image.LANCZOS)
    out.alpha_composite(f, ((size - w) // 2, (size - h) // 2))
    return out


def tile(size: int, mark_size: int, bg, private: bool = False) -> Image.Image:
    t = Image.new("RGBA", (size, size), bg + (255,))
    m = mark(mark_size, private)
    t.alpha_composite(m, ((size - mark_size) // 2, (size - mark_size) // 2))
    return t


def svg_of(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {img.width} {img.height}">'
            f'<image width="{img.width}" height="{img.height}" href="data:image/png;base64,{data}"/></svg>\n')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    content = OUT / "content"
    content.mkdir(exist_ok=True)

    for size in (16, 22, 24, 32, 48, 64, 128, 256):
        mark(size).save(OUT / f"default{size}.png")

    mark(192).save(content / "about-logo.png")
    mark(384).save(content / "about-logo@2x.png")
    mark(192, private=True).save(content / "about-logo-private.png")
    mark(384, private=True).save(content / "about-logo-private@2x.png")
    mark(64).save(content / "about.png")
    (content / "about-logo.svg").write_text(svg_of(mark(384)), encoding="utf-8", newline="\n")

    tile(150, 96, TILE_BG).save(OUT / "VisualElements_150.png")
    tile(70, 44, TILE_BG).save(OUT / "VisualElements_70.png")
    tile(150, 96, PRIVATE_TILE_BG, private=True).save(OUT / "PrivateBrowsing_150.png")
    tile(70, 44, PRIVATE_TILE_BG, private=True).save(OUT / "PrivateBrowsing_70.png")

    # Windows installer (NSIS) art: 24-bit BMPs at the sizes the installer expects.
    header = Image.new("RGBA", (150, 57), (255, 255, 255, 255))
    header.alpha_composite(mark(44), (150 - 44 - 7, 6))
    header.convert("RGB").save(OUT / "wizHeader.bmp")
    header.convert("RGB").transpose(Image.FLIP_LEFT_RIGHT).save(OUT / "wizHeaderRTL.bmp")
    side = Image.new("RGBA", (164, 314), TILE_BG + (255,))
    side.alpha_composite(mark(96), ((164 - 96) // 2, 70))
    side.convert("RGB").save(OUT / "wizWatermark.bmp")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [mark(s) for s in sizes]
    frames[-1].save(OUT / "firefox.ico", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    mark(64).save(OUT / "firefox64.ico", sizes=[(64, 64)])
    pframes = [mark(s, private=True) for s in sizes]
    pframes[-1].save(OUT / "pbmode.ico", sizes=[(s, s) for s in sizes], append_images=pframes[:-1])
    mark(1024).save(OUT / "firefox.icns")
    print(f"Icons written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
