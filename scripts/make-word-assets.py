"""Draws the background images used by the Word version of a formatted CV (lib/format.js).

Word can't draw gradients, rounded bars or a full-page colour, so these parts of the design are
images placed behind the text. They use the same measurements and colours as the PDF, so the
two versions match. Run again only if the design changes:

    python3 scripts/make-word-assets.py

Needs Python with Pillow and NumPy. Writes to lib/assets/.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "lib" / "assets"
DPI = 200
S = DPI / 72  # pixels per point
PAGE_W, PAGE_H = 595.28, 841.89  # A4 in points
M = 48  # page margin in points, as in the PDF
TEAL, AQUA = (0, 200, 200), (115, 247, 187)
MIST = (236, 238, 243)
LOGO_WHITE = Image.open(ROOT / "public" / "logo-dark-bg.png").convert("RGBA")
HEAD_FONT = str(ROOT / "lib" / "fonts" / "Manrope-ExtraBold.ttf")


def px(v):
    return int(round(v * S))


def gradient(w_pt, h_pt, x2_pt, y2_pt):
    """Teal to aquamarine along the line from the top-left corner to (x2, y2), like pdfkit's linearGradient."""
    w, h = px(w_pt), px(h_pt)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    vx, vy = px(x2_pt), px(y2_pt)
    t = np.clip((xs * vx + ys * vy) / float(vx * vx + vy * vy), 0, 1)[..., None]
    rgb = np.array(TEAL, np.float32) * (1 - t) + np.array(AQUA, np.float32) * t
    return Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")


def paste_logo(img, x_pt, y_pt, width_pt):
    w = px(width_pt)
    logo = LOGO_WHITE.resize((w, round(LOGO_WHITE.height * w / LOGO_WHITE.width)), Image.LANCZOS)
    img.alpha_composite(logo, (px(x_pt), px(y_pt)))


def bar(label):
    """The brand bar across the top of a page: gradient, rounded bottom corners, label in a pill, logo."""
    h_pt, r_pt = 70, 18
    img = gradient(PAGE_W, h_pt, PAGE_W, h_pt)
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, -px(r_pt) * 2, img.width - 1, img.height - 1), radius=px(r_pt), fill=255)
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(HEAD_FONT, px(10))
    text = label.upper()
    spacing = px(1)
    text_w = sum(font.getlength(ch) for ch in text) + spacing * (len(text) - 1)
    pill_x, pill_y, pill_h = px(M - 6), px(21), px(28)
    pill_w = text_w + px(32)
    d.rounded_rectangle((pill_x, pill_y, pill_x + pill_w, pill_y + pill_h), radius=pill_h // 2,
                        outline=(255, 255, 255, 255), width=max(2, px(1.3)))
    x, y = pill_x + px(16), pill_y + pill_h / 2
    for ch in text:
        d.text((x, y), ch, font=font, fill=(255, 255, 255, 255), anchor="lm")
        x += font.getlength(ch) + spacing
    paste_logo(img, PAGE_W - M - 42, 14, 42)
    return img


def footer_black():
    """The black footer band (Basic template), rounded at the top. The address is Word text on top."""
    h_pt, r_pt = 36, 16
    img = Image.new("RGBA", (px(PAGE_W), px(h_pt)), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle((0, 0, img.width - 1, img.height + px(r_pt) * 2), radius=px(r_pt), fill=(0, 0, 0, 255))
    return img


def full_page(logo_at=None, logo_w=0):
    img = gradient(PAGE_W, PAGE_H, PAGE_W, PAGE_H)
    if logo_at:
        paste_logo(img, *logo_at, logo_w)
    return img.convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    bar("Candidate Resume").save(OUT / "word-bar-resume.png", optimize=True)

    profile = Image.new("RGBA", (px(PAGE_W), px(PAGE_H)), MIST + (255,))
    profile.alpha_composite(bar("Candidate Profile"), (0, 0))
    profile.convert("RGB").save(OUT / "word-profile-page.jpg", quality=90)

    footer_black().save(OUT / "word-footer-black.png", optimize=True)
    full_page((56, 56), 64).save(OUT / "word-cover-page.jpg", quality=90)
    full_page((PAGE_W - 56 - 72, PAGE_H - 56 - 72), 72).save(OUT / "word-closing-page.jpg", quality=90)
    for f in sorted(OUT.glob("word-*")):
        print(f.name, f.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
