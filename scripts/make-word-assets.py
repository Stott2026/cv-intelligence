"""Draws the page backgrounds for formatted CVs (lib/format.js), used by both the PDF and the Word file.

Follows the Stott and May brand skill (references/layout-patterns.md and the example collateral):
- cover: dark #111314 page, logo top-left, a soft teal glow from the left edge and the glowing wave
  line crossing the lower third (the signature cover device);
- CV pages: light #ECEEF3 page with a white rounded card for the content;
- closing: radial gradient, aquamarine centre to teal edges, logo top-left.
Text is never baked in: the PDF and Word file put real text on top. Run again if the design changes:

    python3 scripts/make-word-assets.py

Needs Python with Pillow and NumPy. Writes to lib/assets/.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "lib" / "assets"
DPI = 200
S = DPI / 72  # pixels per point
PAGE_W, PAGE_H = 595.28, 841.89  # A4 in points
INK, MIST = (17, 19, 20), (236, 238, 243)
TEAL, AQUA = np.array((0, 200, 200), np.float32), np.array((115, 247, 187), np.float32)
LOGO_DARK_BG = Image.open(ROOT / "public" / "logo-dark-bg.png").convert("RGBA")

# Shared with lib/format.js (CARD): the white card on CV pages, in points.
CARD = {"x": 28, "y": 28, "w": PAGE_W - 56, "bottom": PAGE_H - 60, "r": 16}


def px(v):
    return int(round(v * S))


def blank(color):
    return Image.new("RGBA", (px(PAGE_W), px(PAGE_H)), tuple(color) + (255,))


def paste_logo(img, x_pt, y_pt, width_pt):
    w = px(width_pt)
    logo = LOGO_DARK_BG.resize((w, round(LOGO_DARK_BG.height * w / LOGO_DARK_BG.width)), Image.LANCZOS)
    img.alpha_composite(logo, (px(x_pt), px(y_pt)))


def cover():
    img = blank(INK)
    w, h = img.size
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    # Soft teal glow bleeding in from the left edge.
    d = np.sqrt((xs / (w * 0.55)) ** 2 + ((ys - h * 0.62) / (h * 0.42)) ** 2)
    glow = np.clip(1 - d, 0, 1) ** 2 * 0.38
    base = np.array(INK, np.float32)
    rgb = base * (1 - glow[..., None]) + TEAL * glow[..., None]
    img = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")

    # The glowing wave line rising left to right across the lower third.
    t = np.linspace(0, 1, 600)
    p0, p1, p2, p3 = np.array([-20, 700]), np.array([170, 760]), np.array([330, 560]), np.array([PAGE_W + 20, 600])
    pts = ((1 - t) ** 3)[:, None] * p0 + (3 * (1 - t) ** 2 * t)[:, None] * p1 + (3 * (1 - t) * t ** 2)[:, None] * p2 + (t ** 3)[:, None] * p3
    pts = [(px(x), px(y)) for x, y in pts]
    for width, blur, alpha in ((40, 30, 90), (14, 10, 140), (5, 2, 220)):
        layer = Image.new("L", img.size, 0)
        ImageDraw.Draw(layer).line(pts, fill=alpha, width=px(width / 4) or 1, joint="curve")
        layer = layer.filter(ImageFilter.GaussianBlur(px(blur / 4)))
        colour = gradient_rgba(img.size)
        colour.putalpha(layer)
        img.alpha_composite(colour)
    core = Image.new("L", img.size, 0)
    ImageDraw.Draw(core).line(pts, fill=255, width=max(2, px(1.6)), joint="curve")
    colour = gradient_rgba(img.size, light=True)
    colour.putalpha(core)
    img.alpha_composite(colour)

    paste_logo(img, 56, 56, 64)
    return img.convert("RGB")


def gradient_rgba(size, light=False):
    """Teal on the left to aquamarine on the right (lighter for the wave's bright core)."""
    w, h = size
    t = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]
    rgb = TEAL * (1 - t) + AQUA * t
    if light:
        rgb = rgb * 0.6 + 255 * 0.4
    return Image.fromarray(np.repeat(rgb, h, axis=0).astype(np.uint8), "RGB").convert("RGBA")


def resume_page():
    img = blank(MIST)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((px(CARD["x"]), px(CARD["y"]), px(CARD["x"] + CARD["w"]), px(CARD["bottom"])),
                        radius=px(CARD["r"]), fill=(255, 255, 255, 255))
    return img.convert("RGB")


def closing():
    img = blank(INK)
    w, h = img.size
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    # Radial gradient: aquamarine centre, teal edges (as on the collateral's closing page).
    r = np.sqrt((xs - w * 0.5) ** 2 + (ys - h * 0.45) ** 2) / (0.62 * np.hypot(w, h))
    t = np.clip(r, 0, 1)[..., None]
    rgb = AQUA * (1 - t) + TEAL * t
    img = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")
    paste_logo(img, 56, 56, 64)
    return img.convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("word-*"):
        old.unlink()
    cover().save(OUT / "page-cover.jpg", quality=90)
    resume_page().save(OUT / "page-resume.jpg", quality=92)
    closing().save(OUT / "page-closing.jpg", quality=90)
    for f in sorted(OUT.glob("*")):
        print(f.name, f.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
