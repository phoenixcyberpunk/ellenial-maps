#!/usr/bin/env python3
"""Turns Ellen's hand-drawn icon PNGs (white background, 1024px) into app assets in site/art/:
   <name>-light.png  cropped to the drawing, 192px (transparent background kept)
   <name>-dark.png   the same with the near-black ink swapped for the brand's dark-mode ink,
                     so the outlines stay visible on dark cards and the dark map.
Usage: python3 scripts/make-art.py <source dir>   (files named IMG_xxxx.png as listed in MAP)"""
import sys, os
import numpy as np
from PIL import Image

MAP = {  # source file -> (asset name, swap ink in dark mode?)
    'IMG_0532.png': ('town', True),      # map pin
    'IMG_0534.png': ('urban', True),     # tree = park
    'IMG_0535.png': ('nature', True),    # leaf = nature reserve
    'IMG_0536.png': ('water', True),     # waves = swim
    'IMG_0537.png': ('squares', True),   # fountain (Ellen is redoing this one)
    'IMG_0538.png': ('view', True),      # mountain + sun
    'IMG_0539.png': ('shelter', True),   # umbrella = shelter from rain
    'IMG_0540.png': ('toilet', True),    # WC
    'IMG_0541.png': ('tap', True),       # water tap
    'IMG_0542.png': ('paw', False),      # plain paw: dog mode, light
    'IMG_0543.png': ('paw-halo', False), # paw with cream halo: dog mode, dark
    'IMG_0544.png': ('dogrun', False),   # framed paw: dog run
}
SIZE = 192
DARK_INK = (0xF3, 0xEE, 0xF8)  # --ink in the dark palette
OUT = os.path.join(os.path.dirname(__file__), '..', 'site', 'art')


def cut_out(img):
    """White background -> transparent. Background = everything flood-reachable from the corners
    that is near-white; its inner edge keeps the anti-aliasing as alpha."""
    a = np.asarray(img.convert('RGB')).astype(np.int16)
    h, w, _ = a.shape
    near_white = (a.min(axis=2) > 235)
    # flood fill from the border through near-white pixels
    from collections import deque
    bg = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near_white[y, x] and not bg[y, x]: bg[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near_white[y, x] and not bg[y, x]: bg[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and near_white[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True; q.append((ny, nx))
    # edge ring: non-background pixels touching the background that are lighter than solid ink
    alpha = np.where(bg, 0, 255).astype(np.int16)
    ring = ~bg & (np.roll(bg, 1, 0) | np.roll(bg, -1, 0) | np.roll(bg, 1, 1) | np.roll(bg, -1, 1))
    lum = (a[..., 0] * 299 + a[..., 1] * 587 + a[..., 2] * 114) // 1000
    edge_alpha = np.clip((255 - lum) * 255 // (255 - 90), 0, 255)
    alpha[ring] = np.maximum(edge_alpha[ring], 40)
    rgba = np.dstack([a, alpha]).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA'), bg


def crop_square(img, pad=0.05):
    al = np.asarray(img)[..., 3]
    ys, xs = np.where(al > 8)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    side = max(y1 - y0, x1 - x0)
    p = int(side * pad)
    side += 2 * p
    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.paste(img, (-box[0], -box[1]))
    return out


def swap_ink(img):
    a = np.asarray(img).astype(np.int16)
    rgb, al = a[..., :3], a[..., 3]
    is_ink = (rgb.max(axis=2) < 70) & (al > 0)
    out = a.copy()
    out[is_ink, :3] = DARK_INK
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def main(src):
    os.makedirs(OUT, exist_ok=True)
    for f, (name, swap) in MAP.items():
        img = Image.open(os.path.join(src, f))
        # Ellen's exports are already RGBA with a transparent background; only flatten ones aren't.
        cut = img.convert('RGBA') if img.mode == 'RGBA' else cut_out(img)[0]
        cut = crop_square(cut)
        light = cut.resize((SIZE, SIZE), Image.LANCZOS)
        light.save(os.path.join(OUT, f'{name}-light.png'), optimize=True)
        dark = (swap_ink(cut) if swap else cut).resize((SIZE, SIZE), Image.LANCZOS)
        dark.save(os.path.join(OUT, f'{name}-dark.png'), optimize=True)
        print(name, os.path.getsize(os.path.join(OUT, f'{name}-light.png')), os.path.getsize(os.path.join(OUT, f'{name}-dark.png')))


if __name__ == '__main__':
    main(sys.argv[1])
