"""Repo social card for vendor-dashboard, in the senior-engineering-partner style.
Palette sampled from the reference card (GitHub dark tokens)."""
from PIL import Image, ImageDraw, ImageFont

W, H = 2560, 1280
BG, CARD_BORDER = (13, 17, 23), (48, 54, 61)
AMBER, TITLE, GRAY, DIM, WATERMARK = (227, 179, 65), (230, 237, 243), (139, 148, 158), (110, 118, 129), (22, 27, 34)

MONO, SANS = "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/HelveticaNeue.ttc"
def f(path, size, index=0): return ImageFont.truetype(path, size, index=index)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# faint </> watermark, drawn first so text sits above it
wm = f(MONO, 420)
d.text((1360, 700), "</>", font=wm, fill=WATERMARK)

# card outline
d.rounded_rectangle([55, 55, W - 55, H - 55], radius=28, outline=CARD_BORDER, width=3)

X = 240  # text column
# amber rule
d.rectangle([185, 255, 197, 900], fill=AMBER)

# eyebrow, letter-spaced
eb_font = f(MONO, 40)
x = X
for ch in "A Cloudflare Worker":
    d.text((x, 262), ch, font=eb_font, fill=GRAY)
    x += d.textlength(ch, font=eb_font) + 9

# title: amber slash + repo name (mono)
t_font = f(MONO, 118)
d.text((X, 370), "/", font=t_font, fill=AMBER)
d.text((X + d.textlength("/", font=t_font) + 10, 370), "vendor-dashboard", font=t_font, fill=TITLE)

# subtitles
d.text((X, 560), "Fail-closed status dashboard for ~46 SaaS and cloud vendors", font=f(SANS, 58), fill=TITLE)
d.text((X, 655), "An unverifiable status is unknown, never operational", font=f(SANS, 46), fill=GRAY)

# pills
p_font = f(MONO, 40)
px, py = X, 800
for label in ["JavaScript", "Cloudflare Workers", "D1", "fail-closed"]:
    tw = d.textlength(label, font=p_font)
    d.rounded_rectangle([px, py, px + tw + 64, py + 86], radius=43, outline=CARD_BORDER, width=3)
    d.text((px + 32, py + 18), label, font=p_font, fill=TITLE)
    px += tw + 64 + 40

# footer
ft = f(MONO, 41)
d.text((X, 1060), "github.com/bjgreenberg/vendor-dashboard", font=ft, fill=GRAY)
lic = "Apache-2.0 · open source"
d.text((W - 240 - d.textlength(lic, font=ft), 1060), lic, font=ft, fill=GRAY)

img.save(".github/assets/social-preview.png")
print("written", img.size)
