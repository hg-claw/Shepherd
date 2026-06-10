#!/usr/bin/env python3
"""Generate the Shepherd app icons from the design-system brand (BrandTile "Sh"
+ BrandMark glowing primary dot), using the bundled Geist Mono font.

Regenerate:  python3 scripts/gen-icons.py   (from mobile/)

Outputs (assets/images/): icon.png, android-icon-{foreground,background,monochrome}.png,
splash-icon.png, favicon.png. Colors are the dark-theme tokens from src/theme/tokens.ts:
bg hsl(240 4% 5%) = #0C0C0D, fg hsl(60 3% 93%) = #EEEEEC, primary hsl(213 92% 67%) = #5DA3F8.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'images')
FONT = os.path.join(ROOT, 'node_modules', '@expo-google-fonts', 'geist-mono',
                    '600SemiBold', 'GeistMono_600SemiBold.ttf')

BG = (12, 12, 13, 255)        # #0C0C0D
FG = (238, 238, 236, 255)     # #EEEEEC
PRIMARY = (93, 163, 248, 255) # #5DA3F8


def brand(size: int, fg=FG, dot=PRIMARY, glow=True, transparent=False) -> Image.Image:
    """Render 'Sh' centered with the glowing primary dot tucked at its upper right."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0) if transparent else BG)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * 0.46))
    bbox = d.textbbox((0, 0), 'Sh', font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0]
    ty = (size - th) / 2 - bbox[1] + size * 0.02
    d.text((tx, ty), 'Sh', font=font, fill=fg)

    r = size * 0.045
    cx = tx + bbox[0] + tw + size * 0.075
    cy = ty + bbox[1] + size * 0.01
    if glow:
        halo = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        hd = ImageDraw.Draw(halo)
        hr = r * 2.6
        hd.ellipse((cx - hr, cy - hr, cx + hr, cy + hr), fill=dot[:3] + (160,))
        halo = halo.filter(ImageFilter.GaussianBlur(size * 0.035))
        img = Image.alpha_composite(img, halo)
        d = ImageDraw.Draw(img)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=dot)
    return img


def save(img: Image.Image, name: str):
    img.save(os.path.join(OUT, name))
    print(f'  {name}  {img.size[0]}x{img.size[1]}')


# Universal icon (iOS + fallback): full-bleed dark tile.
save(brand(1024), 'icon.png')

# Android adaptive: foreground content inside the ~66% safe zone, transparent.
fg = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
fg.alpha_composite(brand(340, transparent=True), (86, 86))
save(fg, 'android-icon-foreground.png')
save(Image.new('RGBA', (512, 512), BG), 'android-icon-background.png')

mono = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
mono.alpha_composite(brand(340, fg=(255, 255, 255, 255), dot=(255, 255, 255, 255),
                           glow=False, transparent=True), (86, 86))
save(mono, 'android-icon-monochrome.png')

# Splash mark (white Sh + primary dot on the dark splash background color).
save(brand(512, transparent=True), 'splash-icon.png')

save(brand(1024).resize((64, 64), Image.LANCZOS), 'favicon.png')
print('done')
