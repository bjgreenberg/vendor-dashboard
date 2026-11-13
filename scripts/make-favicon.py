"""Favicon for the service-status page: a status list with three lights.

Writes three files under public/service-status/:

  favicon.svg            the tab icon for browsers that take SVG
  favicon-48.png         the PNG fallback (48 px covers 16 and 32 at 2x and 3x)
  apple-touch-icon.png   180 px, full bleed (iOS rounds the corners itself)

The heading mark on the page (HEADING_MARK in src/worker/render.js) has an
open box and two signal arcs. At 16 px those blur away, so this is the
simplified form: a solid tile, three lights, three lines.

The lights are FIXED colours. The icon never reflects the board's state
(Brian, 2026-11-13): a tab icon that turned red would be a second status
signal with none of the board's fail-closed rules behind it.

The tile carries a thin light border because a navy tile on a dark browser
tab is otherwise invisible. One geometry feeds both the SVG and the PNGs, so
the two cannot drift. Run from the repo root: python3 scripts/make-favicon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path("public/service-status")

GRID = 64  # all geometry below is on a 64 x 64 grid
TILE, BORDER, LINE = "#1b2740", "#8f9bb0", "#e6e9ee"
LIGHTS = ("#ff5a4f", "#ffc21a", "#34c26e")  # red, yellow, green, top to bottom
ROWS = (18, 32, 46)  # y of each light and its line
LIGHT_X, LIGHT_R = 20, 6.5
LINE_X0, LINE_X1, LINE_W = 33, 48, 5
TILE_INSET, TILE_RADIUS, BORDER_W = 3, 14, 2.5


def svg() -> str:
    """The tab icon as SVG, built from the constants above."""
    size = GRID - 2 * TILE_INSET
    lights = "".join(
        f'<circle cx="{LIGHT_X}" cy="{y}" r="{LIGHT_R}" fill="{c}"/>' for y, c in zip(ROWS, LIGHTS)
    )
    lines = "".join(f"M{LINE_X0} {y}H{LINE_X1}" for y in ROWS)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {GRID} {GRID}">'
        f'<rect x="{TILE_INSET}" y="{TILE_INSET}" width="{size}" height="{size}" rx="{TILE_RADIUS}" '
        f'fill="{TILE}" stroke="{BORDER}" stroke-width="{BORDER_W}"/>'
        f"{lights}"
        f'<path d="{lines}" stroke="{LINE}" stroke-width="{LINE_W}" stroke-linecap="round"/>'
        "</svg>\n"
    )


def png(px: int, *, full_bleed: bool) -> Image.Image:
    """The same drawing as a PNG of px x px, drawn at 8x and scaled down."""
    scale = 8
    k = px * scale / GRID  # grid units to supersampled pixels
    side = px * scale
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if full_bleed:
        d.rectangle([0, 0, side, side], fill=TILE)
    else:
        inset = TILE_INSET - BORDER_W / 2  # the SVG stroke is centred on the rect edge
        d.rounded_rectangle(
            [inset * k, inset * k, (GRID - inset) * k, (GRID - inset) * k],
            radius=(TILE_RADIUS + BORDER_W / 2) * k,
            fill=TILE,
            outline=BORDER,
            width=round(BORDER_W * k),
        )
    for y, colour in zip(ROWS, LIGHTS):
        d.ellipse(
            [(LIGHT_X - LIGHT_R) * k, (y - LIGHT_R) * k, (LIGHT_X + LIGHT_R) * k, (y + LIGHT_R) * k],
            fill=colour,
        )
        half = LINE_W / 2
        d.rounded_rectangle(
            [(LINE_X0 - half) * k, (y - half) * k, (LINE_X1 + half) * k, (y + half) * k],
            radius=half * k,
            fill=LINE,
        )
    return img.resize((px, px), Image.Resampling.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "favicon.svg").write_text(svg(), encoding="utf-8")
    png(48, full_bleed=False).save(OUT / "favicon-48.png", optimize=True)
    png(180, full_bleed=True).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    for name in ("favicon.svg", "favicon-48.png", "apple-touch-icon.png"):
        print(f"wrote {OUT / name} ({(OUT / name).stat().st_size} bytes)")


if __name__ == "__main__":
    main()
