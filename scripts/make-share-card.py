"""Share card (og:image) for the service-status page: the page's mark, not a portrait.

Brian, 2026-11-13: the board is a tool, so its link preview shows the board's
own mark where the site's page cards show his photograph.

Two steps, both run by hand on macOS from this repo's root:

  1. Draw the brand text panel with the SITE's card tool, as a PNG, so the
     paper, the accent rule, the eyebrow, the serif title and the signature
     stay exactly the site's (that tool measures them; do not re-derive them
     here):

       (cd ~/src/briangreenberg.net && python3 scripts/make_card.py --page \
          --title "Is It Down?" \
          --subtitle "Live status for the cloud and SaaS services we depend on, checked every 15 minutes" \
          --out /tmp/is-it-down-base.png)

  2. Replace its portrait panel with the mark:

       .venv/bin/python scripts/make-share-card.py /tmp/is-it-down-base.png

It writes public/service-status/card-is-it-down.jpg (1200 x 630).

The mark is the same drawing as HEADING_MARK in src/worker/render.js: an open
box, three FIXED lights, three lines, and two signal arcs that share one
centre. The lights never reflect the board's state.

Never delete or overwrite a card that has been live: social sites cache a
preview per URL. A redrawn card gets a NEW file name, and render.js points at it.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path("public/service-status/card-is-it-down.jpg")
W, H = 1200, 630
PANEL_X = 780  # the site tool's portrait panel is the right-hand 420 px
PANEL_BG, STROKE = "#1F2429", "#FAFAF7"  # the site's --ink and --paper
LIGHTS = ("#d93025", "#f2a900", "#1e9e57")  # red, yellow, green, top to bottom

# The mark's geometry, in the units of HEADING_MARK's viewBox ("10 14 112 116").
VB_X, VB_Y, VB_W, VB_H = 10, 14, 112, 116
STROKE_W = 8.0
MARK_PX = 300  # drawn width of the mark on the card
SS = 4  # supersampling factor


def draw_mark(size: int) -> Image.Image:
    """The mark on a transparent square-ish canvas `size` px wide, antialiased."""
    k = size * SS / VB_W  # viewBox units to supersampled pixels
    img = Image.new("RGBA", (round(VB_W * k), round(VB_H * k)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = STROKE_W * k

    def pt(x: float, y: float) -> tuple[float, float]:
        return ((x - VB_X) * k, (y - VB_Y) * k)

    def dot(x: float, y: float, r: float, fill: str) -> None:
        cx, cy = pt(x, y)
        d.ellipse([cx - r * k, cy - r * k, cx + r * k, cy + r * k], fill=fill)

    def line(x0: float, y0: float, x1: float, y1: float) -> None:
        d.line([pt(x0, y0), pt(x1, y1)], fill=STROKE, width=round(w))
        dot(x0, y0, STROKE_W / 2, STROKE)  # round caps
        dot(x1, y1, STROKE_W / 2, STROKE)

    def arc(cx: float, cy: float, r: float, start: int, end: int) -> None:
        # Pillow draws an arc's width INWARD from the box, so the box is grown
        # by half the stroke to centre the stroke on radius r. Angles are
        # clockwise from 3 o'clock.
        x, y = pt(cx, cy)
        outer = (r + STROKE_W / 2) * k
        d.arc([x - outer, y - outer, x + outer, y + outer], start, end, fill=STROKE, width=round(w))

    # The box, open at the top right: top edge, three rounded corners, right edge.
    line(54, 36, 32, 36)
    arc(32, 54, 18, 180, 270)
    line(14, 54, 14, 108)
    arc(32, 108, 18, 90, 180)
    line(32, 126, 86, 126)
    arc(86, 108, 18, 0, 90)
    line(104, 108, 104, 82)
    # Two signal arcs, one centre, so they stay parallel. Caps on both ends.
    for r in (20, 40):
        arc(74, 62, r, 270, 360)
        dot(74, 62 - r, STROKE_W / 2, STROKE)
        dot(74 + r, 62, STROKE_W / 2, STROKE)
    # Three rows: a light and a line each.
    for y, colour in zip((66, 86, 106), LIGHTS):
        dot(34, y, 7.5, colour)
        line(54, y, 80, y)
    return img.resize((size, round(size * VB_H / VB_W)), Image.Resampling.LANCZOS)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    base = Image.open(sys.argv[1]).convert("RGB")
    if base.size != (W, H):
        print(f"{sys.argv[1]} is {base.size}, want {(W, H)}: is it a page card from the site tool?", file=sys.stderr)
        return 1
    d = ImageDraw.Draw(base)
    d.rectangle([PANEL_X, 0, W, H], fill=PANEL_BG)
    mark = draw_mark(MARK_PX)
    x = PANEL_X + (W - PANEL_X - mark.width) // 2
    y = (H - mark.height) // 2
    base.paste(mark, (x, y), mark)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    base.save(OUT, quality=90, optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
