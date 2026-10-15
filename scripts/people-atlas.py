#!/usr/bin/env python3
"""Saltline people atlas (public/js/people.js): an 8 x 8 grid of 128 px tiles (1024 px), drawn procedurally with Pillow +
numpy at 2x and downsampled, then encoded to KTX2 (ETC1S, sRGB, full mips) with KTX-Software toktx like the texture
library (public/assets/lib/SOURCES.md). Own work, CC0.

  python3 people-atlas.py layout.json outdir        -> outdir/albedo.png (1024), albedo_512.png, means.json

Layout (scripts/people-atlas-layout.json, generated from people.js): tile i is at column i % 8, row i // 8 (row 0 = top of
the image; KTX2 is not flipped, so v = 0 in GL samples the top row). Inside a tile the shader samples
(pad + u * (1 - 2 pad), pad + (1 - v) * (1 - 2 pad)): v = 0 is the BOTTOM of the garment (drawn at the bottom of the tile).
UV conventions (people.js):
  head / hair  u = headU(azimuth): the face (az 0) at u 0.5, the person's left ear (az +90) at 0.875, right ear 0.125, back of
               the head at 0 / 1 (the front half gets 75 % of the width); v = 1 - polar angle / pi (top of the head = 1).
  tops         u 0 .. 0.75 = around the torso (0.375 = the front centre, 0 / 0.75 = the back seam, 0.1875 = the person's
               right side, 0.5625 = the left), v 0 = hips (0.875 m) .. 1 = neck (1.49 m);
               u 0.75 .. 1 = the sleeve (0.875 = the front of the arm), v 0 = wrist .. 1 = shoulder cap; short sleeves end
               at v 0.675 (the forearm is bare skin when the person's look says so).
  bottoms      u around the leg (0.5 = front), v 0 = ankle .. 1 = hip; the shorts line is v 0.566, the knee v 0.45.
  shoes        u around the shoe (0.5 = the top / laces, 0 / 1 = the sole), v 0 = heel .. 1 = toe.
"tint" tiles are neutral grey (multiplied by a per-person colour in the shader); "true" tiles are drawn in colour.
"""
import json
import math
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

S = 256           # supersampled tile size (the atlas is 8 x 256 = 2048 before the 2x downsample)
G = 8
rng = np.random.default_rng(1234)


def hexrgb(h):
    return np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], dtype=np.float32) / 255.0


def mix(a, b, t):
    return a * (1 - t) + b * t


class Tile:
    """A tile canvas in float RGB (0..1) with local (u, v) helpers."""

    def __init__(self, pad, base=(0.8, 0.8, 0.8)):
        self.pad = pad
        self.a = np.zeros((S, S, 3), np.float32) + np.array(base, np.float32)
        yy, xx = np.mgrid[0:S, 0:S].astype(np.float32) + 0.5
        s = 1 - 2 * pad
        self.U = (xx / S - pad) / s          # local u of every pixel (can run past 0..1 in the padding)
        self.V = 1 - (yy / S - pad) / s      # local v (1 at the top)

    def px(self, u, v):
        s = 1 - 2 * self.pad
        return ((self.pad + u * s) * S, (self.pad + (1 - v) * s) * S)

    def blend(self, mask, color, alpha=1.0):
        m = np.clip(mask * alpha, 0, 1)[..., None]
        self.a = self.a * (1 - m) + np.array(color, np.float32) * m

    def mul(self, mask, k):
        self.a *= (1 + (k - 1) * np.clip(mask, 0, 1))[..., None]

    def shape(self, draw_fn, blur=0.0):
        """a soft mask (0..1) from Pillow drawing in pixel space: draw_fn(ImageDraw, px)"""
        im = Image.new('L', (S, S), 0)
        draw_fn(ImageDraw.Draw(im), self.px)
        if blur > 0:
            im = im.filter(ImageFilter.GaussianBlur(blur))
        return np.asarray(im, np.float32) / 255.0

    def noise(self, amp, scale=1.0, seed=None):
        r = np.random.default_rng(seed if seed is not None else rng.integers(1 << 30))
        small = max(2, int(S / max(1.0, scale)))
        n = r.standard_normal((small, small)).astype(np.float32)
        n = np.asarray(Image.fromarray(n).resize((S, S), Image.BICUBIC), np.float32)
        self.a *= (1 + amp * n)[..., None]

    def band_v(self, v0, v1, soft=0.004):
        return np.clip((self.V - v0) / soft, 0, 1) * np.clip((v1 - self.V) / soft, 0, 1)

    def band_u(self, u0, u1, soft=0.004):
        return np.clip((self.U - u0) / soft, 0, 1) * np.clip((u1 - self.U) / soft, 0, 1)

    def gauss(self, u, v, su, sv):
        return np.exp(-(((self.U - u) / su) ** 2 + ((self.V - v) / sv) ** 2))


def head_u(az_deg):
    a = abs(az_deg)
    s = 1 if az_deg >= 0 else -1
    if a <= 90:
        return 0.5 + az_deg / 180 * 0.75
    return 0.5 + s * (0.375 + (a - 90) / 90 * 0.125)


def head_v(dy):
    return 1 - math.acos(max(-1, min(1, dy))) / math.pi


def hairline_v(az_deg):
    th = 62 + 63 * (abs(az_deg) / 180) ** 1.3
    return 1 - th / 180


def u_to_az(u):
    """inverse of head_u (array)"""
    d = u - 0.5
    front = np.abs(d) <= 0.375
    az = np.where(front, d / 0.75 * 180, np.sign(d) * (90 + (np.abs(d) - 0.375) / 0.125 * 90))
    return az


# ------------------------------------------------------------------------------------------------ faces
EYES = [0x5b7a99, 0x6b5a3a, 0x4a3426, 0x3a2a1e, 0x2e2018, 0x6a8a6a, 0x4a3a26, 0x33251a]


def face(t, tone_hex, fem, idx):
    skin = hexrgb(tone_hex)
    t.a[:] = skin
    dark = mix(skin, np.array([0.25, 0.12, 0.08], np.float32), 0.35)
    az = u_to_az(t.U)
    front = np.clip(np.cos(np.radians(az)), 0, 1)
    # form shading: sides and back a little darker, under the jaw darker, the scalp in shadow under the hair
    t.mul(1 - front, 0.95)
    t.mul(np.clip((0.2 - t.V) / 0.15, 0, 1), 0.72)
    hl = np.vectorize(hairline_v)(np.clip(az, -180, 180))
    t.mul(np.clip((t.V - hl + 0.02) / 0.04, 0, 1), 0.9)
    t.noise(0.018, 1.5, seed=idx)
    t.noise(0.008, 10, seed=idx + 100)
    eu = 21 / 90 * 0.375
    ev = head_v(0.09)
    # cheeks
    blush = np.array([0.85, 0.35, 0.3], np.float32)
    for s in (-1, 1):
        t.blend(t.gauss(0.5 + s * 0.1, head_v(-0.25), 0.045, 0.05), mix(skin, blush, 0.5), 0.22 if fem else 0.1)
    # eye sockets
    for s in (-1, 1):
        t.mul(t.gauss(0.5 + s * eu, ev + 0.006, 0.06, 0.03), 0.86)
    # brows
    brow = np.array([0.12, 0.08, 0.06], np.float32) if tone_hex not in (0xf5d6bc,) else np.array([0.35, 0.25, 0.15], np.float32)
    bw = 0.012 if fem else 0.017
    for s in (-1, 1):
        def drw(d, px, s=s):
            pts = [px(0.5 + s * (eu - 0.045), head_v(0.25)), px(0.5 + s * (eu - 0.01), head_v(0.285)), px(0.5 + s * (eu + 0.035), head_v(0.282)), px(0.5 + s * (eu + 0.058), head_v(0.255))]
            d.line(pts, fill=255, width=int(bw * S), joint='curve')
        t.blend(t.shape(drw, 1.2), brow, 0.85 if not fem else 0.7)
    # eyes: white, iris, pupil, upper lid line, lashes
    iris = hexrgb(EYES[idx % 8])
    for s in (-1, 1):
        cu = 0.5 + s * eu
        def white(d, px, cu=cu):
            x0, y0 = px(cu - 0.042, ev + 0.016)
            x1, y1 = px(cu + 0.042, ev - 0.016)
            d.ellipse([x0, y0, x1, y1], fill=255)
        t.blend(t.shape(white, 0.8), np.array([0.93, 0.91, 0.88], np.float32), 0.95)
        t.blend(t.gauss(cu + s * 0.004, ev - 0.001, 0.013, 0.016), iris, 1.0)
        t.blend(t.gauss(cu + s * 0.004, ev - 0.001, 0.006, 0.008), np.array([0.03, 0.03, 0.03], np.float32), 1.0)
        t.blend(t.gauss(cu + s * 0.0, ev + 0.006, 0.004, 0.004), np.array([1, 1, 1], np.float32), 0.6)

        def lid(d, px, cu=cu):
            pts = [px(cu - 0.046, ev - 0.002), px(cu - 0.02, ev + 0.017), px(cu + 0.02, ev + 0.018), px(cu + 0.048, ev + 0.003)]
            d.line(pts, fill=255, width=int((0.012 if fem else 0.008) * S), joint='curve')
        t.blend(t.shape(lid, 0.6), np.array([0.08, 0.05, 0.04], np.float32), 0.9)
        t.mul(t.gauss(cu, ev - 0.022, 0.035, 0.006), 0.9)  # lower lid shadow
        if fem:
            t.blend(t.gauss(cu, ev + 0.03, 0.04, 0.012), mix(skin, np.array([0.45, 0.3, 0.35], np.float32), 0.4), 0.35)
    # nose: bridge highlight, tip shadow, nostrils
    nv = head_v(-0.17)
    t.blend(t.gauss(0.5, nv + 0.05, 0.012, 0.05), np.minimum(skin * 1.08, 1), 0.5)
    for s in (-1, 1):
        t.mul(t.gauss(0.5 + s * 0.028, nv + 0.03, 0.01, 0.05), 0.88)
        t.blend(t.gauss(0.5 + s * 0.017, nv - 0.016, 0.009, 0.006), dark * 0.6, 0.85)
    t.mul(t.gauss(0.5, nv - 0.025, 0.035, 0.01), 0.85)
    # mouth
    mv = head_v(-0.5)
    lip = mix(skin, np.array([0.75, 0.3, 0.3], np.float32), 0.55 if fem else 0.3)
    def lips(d, px):
        x0, y0 = px(0.5 - 0.058, mv + 0.012)
        x1, y1 = px(0.5 + 0.058, mv - 0.016)
        d.ellipse([x0, y0, x1, y1], fill=255)
    t.blend(t.shape(lips, 1.0), lip, 0.9)
    def line(d, px):
        d.line([px(0.5 - 0.06, mv + 0.001), px(0.5, mv - 0.002), px(0.5 + 0.06, mv + 0.001)], fill=255, width=max(2, int(0.006 * S)), joint='curve')
    t.blend(t.shape(line, 0.6), dark * 0.5, 0.9)
    t.mul(t.gauss(0.5, mv + 0.035, 0.012, 0.018), 0.92)   # philtrum
    t.mul(t.gauss(0.5, mv - 0.05, 0.05, 0.015), 0.9)     # under the lip
    if not fem:
        stub = (t.gauss(0.5, head_v(-0.7), 0.16, 0.12) + t.gauss(0.5, mv + 0.03, 0.06, 0.012)) * front
        t.mul(stub, 0.93)
    # chin highlight, ears
    t.blend(t.gauss(0.5, head_v(-0.82), 0.04, 0.03), np.minimum(skin * 1.06, 1), 0.4)
    for u in (0.125, 0.875):
        def ear(d, px, u=u):
            x0, y0 = px(u - 0.035, 0.56)
            x1, y1 = px(u + 0.035, 0.44)
            d.ellipse([x0, y0, x1, y1], outline=255, width=int(0.012 * S))
        t.mul(t.shape(ear, 1.5), 0.8)
        t.mul(t.gauss(u, 0.5, 0.012, 0.03), 0.8)


# ------------------------------------------------------------------------------------------------ hair and hats
def strands(t, amp, dirx, diry, seed, scale=60):
    r = np.random.default_rng(seed)
    n = r.standard_normal((S // 2, S // 2)).astype(np.float32)
    im = Image.fromarray(((n * 0.5 + 0.5).clip(0, 1) * 255).astype(np.uint8)).resize((S, S), Image.BILINEAR)
    k = int(scale * 0.2) | 1
    im = im.filter(ImageFilter.GaussianBlur(radius=(0.6)))
    # motion-blur-like streaks: blur along one axis
    arr = np.asarray(im, np.float32) / 255.0
    if diry:
        arr = np.asarray(Image.fromarray((arr * 255).astype(np.uint8)).resize((S // 20, S), Image.BILINEAR).resize((S, S), Image.BICUBIC), np.float32) / 255.0
    else:
        arr = np.asarray(Image.fromarray((arr * 255).astype(np.uint8)).resize((S, S // 20), Image.BILINEAR).resize((S, S), Image.BICUBIC), np.float32) / 255.0
    t.a *= (1 + amp * (arr - 0.5) * 2)[..., None]
    del k


def hair(t, style, idx):
    t.a[:] = 0.74
    az = u_to_az(t.U)
    hl = np.vectorize(hairline_v)(np.clip(az, -180, 180))
    if style == 'curly':
        r = np.random.default_rng(idx)
        for _ in range(900):
            u, v, rad = r.random(), 0.2 + r.random() * 0.82, 0.008 + r.random() * 0.012
            t.mul(t.gauss(u, v, rad, rad), 0.75 + r.random() * 0.15)
            t.blend(t.gauss(u + rad * 0.3, v + rad * 0.3, rad * 0.4, rad * 0.4), (0.95, 0.95, 0.95), 0.25)
    else:
        strands(t, 0.35 if style != 'short' else 0.25, 0, 1, idx)
        strands(t, 0.12, 1, 0, idx + 7)
    # sheen band and darker roots at the hairline edge (the fringe), the crown whorl
    t.blend(t.band_v(0.72, 0.8, 0.05), (0.95, 0.95, 0.95), 0.25 if style in ('long', 'bun', 'side') else 0.12)
    t.mul(np.clip(1 - (t.V - hl) / 0.05, 0, 1), 0.7)
    if style == 'side':
        def part(d, px):
            d.line([px(0.56, 0.98), px(0.565, 0.7)], fill=255, width=int(0.01 * S))
        t.mul(t.shape(part, 1.0), 0.6)
    if style == 'bun':
        for u in (0.0, 1.0):
            t.mul(t.gauss(u, 0.62, 0.07, 0.07), 0.75)
            t.blend(t.gauss(u, 0.64, 0.035, 0.035), (0.9, 0.9, 0.9), 0.25)
    if style == 'long':
        t.mul(t.band_v(-0.1, 0.45, 0.08), 0.85)


def hard_hat(t, col):
    c = hexrgb(col)
    t.a[:] = c
    t.mul(np.clip((0.75 - t.V) / 0.4, 0, 1), 0.8)            # lower sides darker
    t.blend(t.gauss(0.45, 0.88, 0.12, 0.06), (1, 1, 1), 0.35)  # highlight
    for u in (0.5, 0.0, 1.0):
        t.mul(t.band_u(u - 0.012, u + 0.012, 0.006), 0.82)      # centre ridge
    az = u_to_az(t.U)
    hl = np.vectorize(hairline_v)(np.clip(az, -180, 180))
    t.mul(np.clip(1 - (t.V - hl) / 0.035, 0, 1), 0.65)          # brim shadow line
    t.noise(0.02, 30, seed=5)
    def logo(d, px):
        x0, y0 = px(0.47, 0.8)
        x1, y1 = px(0.53, 0.74)
        d.ellipse([x0, y0, x1, y1], fill=255)
    t.blend(t.shape(logo, 0.8), (0.15, 0.2, 0.35), 0.6)


def officer_hat(t):
    navy, white, gold, black = hexrgb(0x1c2338), hexrgb(0xf2f2ee), hexrgb(0xd9b04a), hexrgb(0x0e0e10)
    t.a[:] = white
    az = u_to_az(t.U)
    hl = np.vectorize(hairline_v)(np.clip(az, -180, 180))
    t.blend(np.clip((hl + 0.14 - t.V) / 0.01, 0, 1), navy)
    t.blend(np.clip((hl + 0.05 - t.V) / 0.006, 0, 1) * np.clip((t.V - hl - 0.02) / 0.006, 0, 1), gold)
    t.blend(t.band_u(0.33, 0.67, 0.02) * np.clip((hl + 0.04 - t.V) / 0.01, 0, 1), black)
    t.blend(t.gauss(0.5, hl + 0.1, 0.02, 0.025), gold, 1.0)
    t.noise(0.02, 40, seed=9)


def bandana(t):
    t.a[:] = hexrgb(0xa8232b)
    r = np.random.default_rng(3)
    for _ in range(140):
        u, v = r.random(), 0.3 + r.random() * 0.7
        t.blend(t.gauss(u, v, 0.008, 0.008), (0.95, 0.92, 0.88), 0.8)
    for u in (0.0, 1.0):
        t.mul(t.gauss(u, 0.42, 0.05, 0.05), 0.7)
    strands(t, 0.1, 1, 0, 11)


def beanie(t):
    t.a[:] = 0.72
    t.a *= (1 + 0.12 * np.sin(t.U * math.pi * 2 * 40))[..., None]
    az = u_to_az(t.U)
    hl = np.vectorize(hairline_v)(np.clip(az, -180, 180))
    fold = np.clip((hl + 0.09 - t.V) / 0.008, 0, 1)
    t.mul(fold, 1.12)
    t.mul(np.clip(1 - np.abs(t.V - hl - 0.09) / 0.008, 0, 1), 0.7)
    t.noise(0.05, 50, seed=4)


# ------------------------------------------------------------------------------------------------ tops
TORSO_FRONT = 0.375
SLEEVE = 0.75


def torso_mask(t):
    return (t.U < 0.75).astype(np.float32)


def sleeve_mask(t):
    return (t.U >= 0.75).astype(np.float32)


def fabric(t, amp=0.05, weave=0.03):
    t.noise(amp * 0.6, 1.5)
    t.noise(amp * 0.25, 12)
    t.a *= (1 + weave * np.sin(t.U * S * 1.6) * np.sin(t.V * S * 1.6))[..., None]


def side_seams(t, k=0.85):
    for u in (0.1875, 0.5625, 0.0, 0.75):
        t.mul(t.band_u(u - 0.004, u + 0.004, 0.003) * torso_mask(t), k)
    t.mul(t.band_u(0.995, 1.01, 0.003), k)


def folds(t, k=0.92):
    for v in (0.12, 0.2, 0.3):
        t.mul(t.gauss(TORSO_FRONT, v, 0.18, 0.012) * torso_mask(t), k)
    for v in (0.62, 0.7):  # elbow creases
        t.mul(t.gauss(0.875, v - 0.25, 0.06, 0.01) * sleeve_mask(t), k)


def crew_neck(t, col=None, k=0.8):
    m = t.band_v(0.955, 1.02, 0.006) * torso_mask(t)
    if col is not None:
        t.blend(m, col)
    else:
        t.mul(m, k)


def hem(t, k=0.82):
    t.mul(t.band_v(-0.02, 0.035, 0.005) * torso_mask(t), k)
    t.mul(t.band_v(-0.02, 0.025, 0.005) * sleeve_mask(t), k)


def short_hem(t, k=0.8):
    t.mul(t.band_v(0.66, 0.69, 0.004) * sleeve_mask(t), k)


def buttons(t, u, vs, col, r=0.008, ring=True):
    for v in vs:
        t.blend(t.gauss(u, v, r, r), col, 1.0)
        if ring:
            t.mul(t.gauss(u - r * 0.4, v - r * 0.4, r * 0.6, r * 0.6), 0.85)


def placket(t, v0, v1, k=0.9):
    t.mul(t.band_u(TORSO_FRONT - 0.012, TORSO_FRONT - 0.009, 0.002) * t.band_v(v0, v1), k)
    t.mul(t.band_u(TORSO_FRONT + 0.009, TORSO_FRONT + 0.012, 0.002) * t.band_v(v0, v1), k)


def collar(t, col, depth=0.06, k=None):
    def drw(d, px):
        for s in (-1, 1):
            d.polygon([px(TORSO_FRONT, 0.94), px(TORSO_FRONT + s * 0.07, 1.02), px(TORSO_FRONT + s * 0.2, 1.02), px(TORSO_FRONT + s * 0.12, 0.96), px(TORSO_FRONT + s * 0.03, 0.88 - depth * 0.3)], fill=255)
        d.rectangle([px(0, 1.05)[0], px(0, 1.05)[1], px(0.75, 0.955)[0], px(0.75, 0.955)[1]], fill=255)
    m = t.shape(drw, 1.0)
    t.blend(m, col if k is None else t.a.mean(axis=(0, 1)) * k)
    t.mul(t.shape(lambda d, px: [d.line([px(TORSO_FRONT + s * 0.03, 0.88 - depth * 0.3), px(TORSO_FRONT + s * 0.12, 0.96)], fill=255, width=3) for s in (-1, 1)], 0.8), 0.7)


def cuff(t, k=0.85, v1=0.07):
    t.mul(t.band_v(-0.02, v1, 0.004) * sleeve_mask(t), k)
    t.mul(t.band_v(v1 - 0.004, v1 + 0.004, 0.002) * sleeve_mask(t), 0.75)


def vee(t, depth, width, col=None, k=None):
    def drw(d, px):
        d.polygon([px(TORSO_FRONT - width, 1.05), px(TORSO_FRONT + width, 1.05), px(TORSO_FRONT, depth)], fill=255)
    m = t.shape(drw, 1.0)
    if col is not None:
        t.blend(m, col)
    return m


def top_tee(t, ringer=False):
    t.a[:] = 0.86
    fabric(t)
    side_seams(t); folds(t); hem(t); short_hem(t)
    crew_neck(t, (0.6, 0.6, 0.6) if ringer else None)
    if ringer:
        t.mul(t.band_v(0.64, 0.69, 0.004) * sleeve_mask(t), 0.7)
    t.mul(t.band_v(0.88, 0.9, 0.004) * sleeve_mask(t), 0.85)  # shoulder seam


def top_polo(t):
    top_tee(t)
    collar(t, None, 0.0, 1.05)
    placket(t, 0.76, 0.95)
    buttons(t, TORSO_FRONT, (0.79, 0.85, 0.91), (0.95, 0.95, 0.95), 0.006)


def top_shirt(t, base=0.88, pocket=True):
    t.a[:] = base
    fabric(t, 0.04, 0.02)
    side_seams(t); folds(t); hem(t); cuff(t)
    placket(t, 0.0, 0.95)
    buttons(t, TORSO_FRONT, [0.08 + 0.13 * i for i in range(7)], (0.97, 0.97, 0.97), 0.006)
    collar(t, None, 0.04, 1.04)
    if pocket:
        t.mul(t.band_u(TORSO_FRONT + 0.06, TORSO_FRONT + 0.13, 0.003) * t.band_v(0.62, 0.74, 0.003), 0.94)
        t.mul(t.band_u(TORSO_FRONT + 0.06, TORSO_FRONT + 0.13, 0.003) * t.band_v(0.735, 0.745, 0.002), 0.8)


def top_stripes(t):
    t.a[:] = 0.92
    stripe = (np.sin(t.V * math.pi * 2 * 13) > 0.25).astype(np.float32)
    t.mul(stripe, 0.48)
    fabric(t, 0.04); side_seams(t); folds(t); hem(t); short_hem(t); crew_neck(t, (0.92, 0.92, 0.92))


def top_floral(t):
    top_shirt(t, 0.82, pocket=False)
    r = np.random.default_rng(21)
    for _ in range(70):
        u, v = r.random(), r.random() * 1.05
        k = 1.18 if r.random() < 0.5 else 0.62
        for p in range(5):
            a = p / 5 * math.tau
            t.mul(t.gauss(u + math.cos(a) * 0.014, v + math.sin(a) * 0.014, 0.01, 0.01), k)
        t.blend(t.gauss(u, v, 0.006, 0.006), (0.98, 0.98, 0.98), 0.6)


def top_blouse(t):
    t.a[:] = 0.9
    fabric(t, 0.03, 0.01)
    side_seams(t, 0.9); hem(t)
    vee(t, 0.8, 0.07)
    t.mul(t.shape(lambda d, px: d.line([px(TORSO_FRONT - 0.07, 1.02), px(TORSO_FRONT, 0.8), px(TORSO_FRONT + 0.07, 1.02)], fill=255, width=4), 1.0), 0.7)
    t.mul(vee(t, 0.8, 0.07) * 0, 1)
    for i in range(9):
        t.mul(t.gauss(TORSO_FRONT - 0.15 + i * 0.04, 0.3, 0.008, 0.25), 0.94)   # gathered folds
    buttons(t, TORSO_FRONT, (0.55, 0.65, 0.75), (0.98, 0.98, 0.98), 0.005)
    t.blend(t.gauss(0.875, 0.5, 0.05, 0.5) * sleeve_mask(t), (0.98, 0.98, 0.98), 0.2)
    cuff(t, 0.9, 0.05)


def top_hoodie(t):
    t.a[:] = 0.84
    fabric(t, 0.05, 0.0)
    side_seams(t); folds(t, 0.9)
    t.mul(t.band_v(-0.02, 0.07, 0.004) * torso_mask(t), 0.85); cuff(t, 0.85, 0.08)
    t.mul(t.band_u(TORSO_FRONT - 0.11, TORSO_FRONT + 0.11, 0.004) * t.band_v(0.1, 0.36, 0.004), 0.9)     # pocket
    t.mul(t.band_u(TORSO_FRONT - 0.11, TORSO_FRONT + 0.11, 0.003) * t.band_v(0.355, 0.365, 0.002), 0.7)
    for s in (-1, 1):
        t.blend(t.band_u(TORSO_FRONT + s * 0.03 - 0.003, TORSO_FRONT + s * 0.03 + 0.003, 0.002) * t.band_v(0.72, 0.95, 0.003), (0.97, 0.97, 0.97), 0.9)
    t.mul(t.band_v(0.9, 1.05, 0.03) * (np.abs(t.U - 0.0) < 0.2).astype(np.float32), 0.75)   # the hood at the back
    t.mul(t.band_v(0.9, 1.05, 0.03) * (np.abs(t.U - 0.75) < 0.2).astype(np.float32) * torso_mask(t), 0.75)


def top_blazer(t):
    t.a[:] = 0.8
    fabric(t, 0.03, 0.02); side_seams(t, 0.88); cuff(t, 0.9, 0.06)
    shirt = vee(t, 0.55, 0.075, (0.98, 0.98, 0.98))
    for s in (-1, 1):
        t.mul(t.shape(lambda d, px, s=s: d.polygon([px(TORSO_FRONT + s * 0.075, 1.02), px(TORSO_FRONT + s * 0.16, 0.85), px(TORSO_FRONT + s * 0.02, 0.56)], fill=255), 1.0), 0.86)
    buttons(t, TORSO_FRONT + 0.012, (0.42, 0.3), (0.35, 0.35, 0.35), 0.008)
    for s in (-1, 1):
        t.mul(t.band_u(TORSO_FRONT + s * 0.12 - 0.04, TORSO_FRONT + s * 0.12 + 0.04, 0.003) * t.band_v(0.2, 0.215, 0.002), 0.75)
    t.mul(t.band_v(-0.02, 0.03) * torso_mask(t), 0.85)
    del shirt


def hivis(t, vest_hex):
    navy = hexrgb(0x1f2a44)
    vest = hexrgb(vest_hex)
    t.a[:] = navy
    t.blend(torso_mask(t), vest)
    silver = np.array([0.82, 0.84, 0.86], np.float32)
    for v0 in (0.24, 0.42):
        t.blend(t.band_v(v0, v0 + 0.05, 0.003) * torso_mask(t), silver)
    for u in (TORSO_FRONT - 0.09, TORSO_FRONT + 0.09, 0.09, 0.66):
        t.blend(t.band_u(u - 0.018, u + 0.018, 0.003) * t.band_v(0.47, 1.05, 0.003) * torso_mask(t), silver)
    t.mul(t.band_u(TORSO_FRONT - 0.003, TORSO_FRONT + 0.003, 0.002) * torso_mask(t), 0.6)  # zip
    t.blend(t.band_v(0.9, 1.05, 0.03) * ((np.abs(t.U - 0.1875) < 0.05) | (np.abs(t.U - 0.5625) < 0.05)).astype(np.float32) * torso_mask(t), navy, 0.9)  # armholes
    fabric(t, 0.04, 0.02); hem(t); cuff(t, 0.8, 0.07)
    t.blend(t.band_v(0.9, 1.0, 0.01) * sleeve_mask(t), vest, 0.0)


def officer(t):
    white, navy, black, gold = hexrgb(0xeeeeea), hexrgb(0x14213d), hexrgb(0x111111), hexrgb(0xd9b04a)
    t.a[:] = white
    fabric(t, 0.03, 0.02); side_seams(t, 0.9); folds(t, 0.94); short_hem(t, 0.82)
    t.blend(t.band_v(-0.05, 0.13, 0.004) * torso_mask(t), navy)          # trousers at the hips
    t.blend(t.band_v(0.12, 0.16, 0.003) * torso_mask(t), black)          # belt
    t.blend(t.gauss(TORSO_FRONT, 0.14, 0.012, 0.012), gold)              # buckle
    placket(t, 0.16, 0.95, 0.88)
    buttons(t, TORSO_FRONT, [0.22 + 0.12 * i for i in range(6)], (0.98, 0.98, 0.98), 0.005)
    for s in (-1, 1):
        t.mul(t.band_u(TORSO_FRONT + s * 0.1 - 0.035, TORSO_FRONT + s * 0.1 + 0.035, 0.003) * t.band_v(0.62, 0.74, 0.003), 0.93)
        t.mul(t.band_u(TORSO_FRONT + s * 0.1 - 0.035, TORSO_FRONT + s * 0.1 + 0.035, 0.003) * t.band_v(0.7, 0.74, 0.003), 0.88)
    collar(t, white, 0.03)
    # epaulettes: black boards with gold stripes on the shoulder cap of the sleeve
    t.blend(t.band_v(0.9, 1.05, 0.004) * sleeve_mask(t), black)
    for v in (0.93, 0.955, 0.98):
        t.blend(t.band_v(v - 0.005, v + 0.005, 0.002) * sleeve_mask(t), gold)


def captain(t):
    navy, white, black, gold = hexrgb(0x1a2238), hexrgb(0xf2f2ee), hexrgb(0x0f0f12), hexrgb(0xe0b84e)
    t.a[:] = navy
    fabric(t, 0.035, 0.03)
    side_seams(t, 0.85)
    vee(t, 0.62, 0.065, white)
    def tie(d, px):
        d.polygon([px(TORSO_FRONT - 0.012, 1.0), px(TORSO_FRONT + 0.012, 1.0), px(TORSO_FRONT + 0.018, 0.7), px(TORSO_FRONT, 0.64), px(TORSO_FRONT - 0.018, 0.7)], fill=255)
    t.blend(t.shape(tie, 0.8), black)
    for s in (-1, 1):   # lapels
        t.mul(t.shape(lambda d, px, s=s: d.polygon([px(TORSO_FRONT + s * 0.065, 1.03), px(TORSO_FRONT + s * 0.17, 0.86), px(TORSO_FRONT + s * 0.115, 0.82), px(TORSO_FRONT + s * 0.012, 0.6)], fill=255), 1.0), 0.78)
    for s in (-1, 1):   # double-breasted gold buttons
        buttons(t, TORSO_FRONT + s * 0.055, (0.22, 0.36, 0.5), gold, 0.009)
    for s in (-1, 1):   # pocket flaps
        t.mul(t.band_u(TORSO_FRONT + s * 0.14 - 0.045, TORSO_FRONT + s * 0.14 + 0.045, 0.003) * t.band_v(0.16, 0.175, 0.002), 0.6)
    t.mul(t.band_u(TORSO_FRONT - 0.17, TORSO_FRONT - 0.11, 0.003) * t.band_v(0.66, 0.672, 0.002), 0.6)
    t.mul(t.band_v(-0.03, 0.025) * torso_mask(t), 0.8)
    # sleeves: 4 gold rings above the cuff, epaulettes (gold boards with 4 stripes) on the shoulder cap
    for i in range(4):
        v = 0.07 + i * 0.03
        t.blend(t.band_v(v, v + 0.014, 0.002) * sleeve_mask(t), gold)
    t.blend(t.band_v(0.9, 1.05, 0.004) * sleeve_mask(t), black)
    for i in range(4):
        v = 0.915 + i * 0.02
        t.blend(t.band_v(v, v + 0.009, 0.002) * sleeve_mask(t), gold)
    t.blend(t.gauss(0.875, 1.0, 0.04, 0.012) * sleeve_mask(t), gold, 0.8)


def waistcoat(t, vest_hex, tie_hex):
    white, black = hexrgb(0xf2f2ee), hexrgb(0x15151a)
    vest = hexrgb(vest_hex)
    t.a[:] = white
    fabric(t, 0.03, 0.02); cuff(t, 0.9, 0.07); folds(t, 0.94)
    t.blend(t.band_v(-0.05, 0.09) * torso_mask(t), black)       # trousers / belt line
    t.blend(t.band_v(0.09, 0.86, 0.003) * torso_mask(t), vest)
    vee(t, 0.55, 0.06, white)
    placket(t, 0.55, 0.95, 0.9)
    buttons(t, TORSO_FRONT + 0.02, (0.2, 0.3, 0.4, 0.5), (0.7, 0.62, 0.4) if vest_hex != 0x15151a else (0.2, 0.2, 0.22), 0.007)
    for u in (0.1875, 0.5625):   # armholes: shirt shows at the sides near the shoulders
        t.blend(t.band_u(u - 0.04, u + 0.04, 0.01) * t.band_v(0.72, 1.05, 0.01), white)
    collar(t, white, 0.02)
    tie = hexrgb(tie_hex)
    def bow(d, px):
        d.polygon([px(TORSO_FRONT - 0.04, 0.985), px(TORSO_FRONT, 0.965), px(TORSO_FRONT + 0.04, 0.985), px(TORSO_FRONT + 0.04, 0.94), px(TORSO_FRONT, 0.96), px(TORSO_FRONT - 0.04, 0.94)], fill=255)
    t.blend(t.shape(bow, 0.6), tie)
    side_seams(t, 0.92)


def chef(t):
    white = hexrgb(0xf4f4f0)
    t.a[:] = white
    fabric(t, 0.03, 0.015); side_seams(t, 0.93); folds(t, 0.92); cuff(t, 0.88, 0.1)
    for s in (-1, 1):
        buttons(t, TORSO_FRONT + s * 0.06, (0.3, 0.45, 0.6, 0.75), (0.2, 0.2, 0.22), 0.008)
    t.mul(t.shape(lambda d, px: d.line([px(TORSO_FRONT + 0.11, 0.0), px(TORSO_FRONT + 0.11, 0.8), px(TORSO_FRONT - 0.04, 0.95)], fill=255, width=3), 0.8), 0.85)
    t.blend(t.band_v(0.95, 1.05, 0.004) * torso_mask(t), white * 0.95)
    t.mul(t.band_v(0.945, 0.952, 0.002) * torso_mask(t), 0.8)
    t.mul(t.band_v(-0.02, 0.03) * torso_mask(t), 0.88)


def performer(t):
    gold, black = hexrgb(0xd8b23c), hexrgb(0x15151a)
    t.a[:] = gold
    r = np.random.default_rng(31)
    sp = r.random((S, S)).astype(np.float32)
    t.a *= (0.75 + 0.5 * (sp > 0.8))[..., None]
    t.a = np.asarray(Image.fromarray((np.clip(t.a, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255.0
    t.blend(t.band_v(-0.05, 0.06) * torso_mask(t), black)
    t.blend(t.band_v(0.955, 1.05, 0.004) * torso_mask(t), black)
    t.blend(t.band_v(-0.05, 0.06) * sleeve_mask(t), black)


def tunic(t, col_hex, trim_hex=0xf4f4f0, zip_=True, pockets=True):
    c, trim = hexrgb(col_hex), hexrgb(trim_hex)
    t.a[:] = c
    fabric(t, 0.04, 0.02); side_seams(t, 0.85); folds(t, 0.92); hem(t); cuff(t, 0.85, 0.06)
    crew_neck(t, trim)
    if zip_:
        t.mul(t.band_u(TORSO_FRONT - 0.003, TORSO_FRONT + 0.003, 0.002) * t.band_v(0.0, 0.97), 0.55)
    if pockets:
        for s in (-1, 1):
            t.mul(t.band_u(TORSO_FRONT + s * 0.11 - 0.04, TORSO_FRONT + s * 0.11 + 0.04, 0.003) * t.band_v(0.62, 0.76, 0.003), 0.9)
            t.mul(t.band_u(TORSO_FRONT + s * 0.11 - 0.04, TORSO_FRONT + s * 0.11 + 0.04, 0.003) * t.band_v(0.735, 0.76, 0.002), 0.8)
    t.blend(t.band_u(TORSO_FRONT + 0.07, TORSO_FRONT + 0.15, 0.003) * t.band_v(0.8, 0.84, 0.003), (0.95, 0.95, 0.95))   # name badge


def coverall(t):
    tunic(t, 0xd8692c, 0xd8692c)
    t.blend(t.band_v(0.55, 0.59, 0.003) * torso_mask(t), (0.82, 0.84, 0.86))
    t.blend(t.band_v(0.3, 0.34, 0.003) * sleeve_mask(t), (0.82, 0.84, 0.86))


def scrubs(t):
    c = hexrgb(0x9cc6d0)
    t.a[:] = c
    fabric(t, 0.035, 0.02); side_seams(t, 0.88); folds(t, 0.93); hem(t); short_hem(t)
    vee(t, 0.8, 0.06, c * 0.82)
    vee(t, 0.83, 0.045, c)
    t.mul(t.band_u(TORSO_FRONT + 0.07, TORSO_FRONT + 0.15, 0.003) * t.band_v(0.6, 0.72, 0.003), 0.9)


def steward(t):
    white, navy, gold = hexrgb(0xf0f0ec), hexrgb(0x14213d), hexrgb(0xd9b04a)
    t.a[:] = white
    fabric(t, 0.03, 0.02); side_seams(t, 0.9); folds(t, 0.93)
    t.blend(t.band_v(0.94, 1.05, 0.004) * torso_mask(t), navy)
    t.blend(t.band_v(-0.02, 0.07, 0.004) * sleeve_mask(t), navy)
    buttons(t, TORSO_FRONT, [0.2 + 0.13 * i for i in range(6)], gold, 0.008)
    t.mul(t.band_v(-0.03, 0.025) * torso_mask(t), 0.85)


def host(t):
    navy, white, red, gold = hexrgb(0x1d2742), hexrgb(0xf2f2ee), hexrgb(0x8a1d2a), hexrgb(0xd9b04a)
    t.a[:] = navy
    fabric(t, 0.03, 0.02); side_seams(t, 0.88); cuff(t, 0.85, 0.06)
    vee(t, 0.58, 0.065, white)
    t.blend(t.shape(lambda d, px: d.polygon([px(TORSO_FRONT - 0.01, 1.0), px(TORSO_FRONT + 0.01, 1.0), px(TORSO_FRONT + 0.015, 0.68), px(TORSO_FRONT, 0.62), px(TORSO_FRONT - 0.015, 0.68)], fill=255), 0.8), red)
    buttons(t, TORSO_FRONT + 0.01, (0.4, 0.28), (0.15, 0.15, 0.18), 0.008)
    t.blend(t.band_u(TORSO_FRONT + 0.09, TORSO_FRONT + 0.15, 0.003) * t.band_v(0.72, 0.75, 0.003), gold)
    t.mul(t.band_v(-0.03, 0.025) * torso_mask(t), 0.85)


def pirate(t):
    linen, leather, sash = hexrgb(0xcfc1a0), hexrgb(0x4a3423), hexrgb(0x7a2020)
    t.a[:] = linen
    fabric(t, 0.08, 0.04); folds(t, 0.85)
    m = torso_mask(t) * (1 - t.band_u(TORSO_FRONT - 0.06, TORSO_FRONT + 0.06, 0.01))
    t.blend(m * t.band_v(0.12, 0.9, 0.01), leather)
    t.noise(0.06, 20, seed=77)
    t.blend(t.band_v(0.06, 0.14, 0.004) * torso_mask(t), sash)
    for i in range(4):   # laces at the open neck
        v = 0.78 + i * 0.045
        t.mul(t.shape(lambda d, px, v=v: d.line([px(TORSO_FRONT - 0.02, v), px(TORSO_FRONT + 0.02, v + 0.03)], fill=255, width=3), 0.6), 0.6)
    t.mul(t.band_v(0.5, 0.56, 0.01) * sleeve_mask(t), 0.8)   # rolled sleeves


def bare(t):
    t.a[:] = 0.86
    t.noise(0.02, 30, seed=8)
    t.mul(t.gauss(TORSO_FRONT, 0.3, 0.008, 0.01), 0.75)                       # navel
    for s in (-1, 1):
        t.mul(t.gauss(TORSO_FRONT + s * 0.06, 0.63, 0.05, 0.012), 0.93)       # chest
        t.mul(t.gauss(TORSO_FRONT + s * 0.07, 0.93, 0.06, 0.008), 0.94)       # collarbones
    t.mul(t.gauss(0.0, 0.55, 0.02, 0.4), 0.95); t.mul(t.gauss(0.75, 0.55, 0.02, 0.4), 0.95)   # spine


def swimsuit(t):
    t.a[:] = 0.85
    fabric(t, 0.03, 0.0)
    for s in (-1, 1):
        t.mul(t.band_u(TORSO_FRONT + s * 0.17 - 0.015, TORSO_FRONT + s * 0.17 + 0.015, 0.004), 0.7)
    vee(t, 0.86, 0.06, (0.7, 0.7, 0.7))
    t.mul(t.band_v(0.66, 0.68, 0.004) * sleeve_mask(t), 0.75)


# ------------------------------------------------------------------------------------------------ bottoms
def legs_base(t, v=0.84):
    t.a[:] = v
    for u in (0.25, 0.75):
        t.mul(t.band_u(u - 0.005, u + 0.005, 0.003), 0.82)
    t.mul(t.band_v(-0.02, 0.03), 0.8)
    t.mul(t.band_v(0.95, 1.05, 0.004), 0.9)            # waistband
    t.mul(t.band_v(0.945, 0.952, 0.002), 0.75)
    for u in (0.1, 0.4, 0.6, 0.9):                     # belt loops
        t.mul(t.band_u(u - 0.006, u + 0.006, 0.002) * t.band_v(0.94, 1.0, 0.002), 0.75)
    for v0 in (0.43, 0.47):                            # knee creases
        t.mul(t.gauss(0.5, v0, 0.15, 0.01), 0.93)


def trousers(t):
    legs_base(t, 0.84)
    fabric(t, 0.03, 0.02)
    t.blend(t.band_u(0.497, 0.503, 0.003), (0.9, 0.9, 0.9), 0.6)   # crease
    t.mul(t.shape(lambda d, px: [d.line([px(0.62, 0.95), px(0.7, 0.8)], fill=255, width=3), d.line([px(0.38, 0.95), px(0.3, 0.8)], fill=255, width=3)], 0.7), 0.75)


def jeans(t):
    legs_base(t, 0.8)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    t.a *= (1 + 0.08 * np.sin((xx + yy) * 1.4))[..., None]
    t.noise(0.08, 60)
    t.blend(t.gauss(0.5, 0.48, 0.12, 0.08), (0.95, 0.95, 0.95), 0.25)   # knee fade
    t.blend(t.gauss(0.5, 0.8, 0.12, 0.1), (0.95, 0.95, 0.95), 0.18)
    for u in (0.247, 0.753):
        t.blend(t.band_u(u - 0.002, u + 0.002, 0.001), (1, 1, 1), 0.5)
    t.mul(t.shape(lambda d, px: [d.arc([px(0.6, 1.0)[0], px(0.6, 1.0)[1], px(0.8, 0.8)[0], px(0.8, 0.8)[1]], 90, 180, fill=255, width=3), d.arc([px(0.2, 1.0)[0], px(0.2, 1.0)[1], px(0.4, 0.8)[0], px(0.4, 0.8)[1]], 0, 90, fill=255, width=3)], 0.7), 0.7)


def chinos(t):
    legs_base(t, 0.86)
    fabric(t, 0.035, 0.03)
    t.mul(t.band_v(0.0, 0.06, 0.003), 0.9)
    t.mul(t.band_v(0.058, 0.064, 0.002), 0.75)          # turn-ups


def hivis_trousers(t):
    t.a[:] = hexrgb(0x243050)
    legs_base(t, 1.0); t.a[:] *= hexrgb(0x243050) / max(1e-3, t.a.mean())
    t.a[:] = hexrgb(0x243050)
    fabric(t, 0.04, 0.02)
    for v0 in (0.18, 0.3):
        t.blend(t.band_v(v0, v0 + 0.045, 0.003), (0.82, 0.84, 0.86))
    t.mul(t.gauss(0.5, 0.46, 0.08, 0.05), 0.8)           # knee pads
    for u in (0.25, 0.75):
        t.mul(t.band_u(u - 0.005, u + 0.005, 0.003), 0.8)


def coverall_trousers(t):
    t.a[:] = hexrgb(0xd5682c)
    fabric(t, 0.04, 0.02)
    t.blend(t.band_v(0.22, 0.26, 0.003), (0.82, 0.84, 0.86))
    t.mul(t.gauss(0.5, 0.46, 0.08, 0.05), 0.85)
    for u in (0.25, 0.75):
        t.mul(t.band_u(u - 0.005, u + 0.005, 0.003), 0.8)
    t.mul(t.band_v(-0.02, 0.03), 0.8)


def uniform_trousers(t):
    t.a[:] = hexrgb(0x1b2236)
    fabric(t, 0.03, 0.02)
    t.blend(t.band_u(0.497, 0.503, 0.003), hexrgb(0x2a3350), 0.8)
    for u in (0.25, 0.75):
        t.mul(t.band_u(u - 0.005, u + 0.005, 0.003), 0.8)
    t.mul(t.band_v(-0.02, 0.03), 0.8)


def swim_shorts(t):
    t.a[:] = 0.84
    fabric(t, 0.03, 0.0)
    r = np.random.default_rng(55)
    for _ in range(40):   # a leaf print
        u, v = r.random(), 0.5 + r.random() * 0.55
        t.mul(t.gauss(u, v, 0.03, 0.012), 0.72)
    for u in (0.25, 0.75):
        t.blend(t.band_u(u - 0.02, u + 0.02, 0.003), (0.97, 0.97, 0.97), 0.8)   # side stripe
    t.mul(t.band_v(0.93, 1.05, 0.004), 0.8)
    t.blend(t.band_u(0.48, 0.52, 0.003) * t.band_v(0.85, 0.95, 0.003), (1, 1, 1), 0.7)   # drawstring
    t.mul(t.band_v(0.56, 0.58, 0.003), 0.75)


# ------------------------------------------------------------------------------------------------ shoes
def sole_mask(t, w=0.13):
    return np.clip((w - np.minimum(t.U, 1 - t.U)) / 0.01, 0, 1)


def sneaker(t):
    t.a[:] = 0.8
    fabric(t, 0.04, 0.0)
    t.blend(sole_mask(t, 0.15), (0.98, 0.98, 0.98))
    t.mul(t.band_u(0.13, 0.15, 0.003), 0.7)
    for i in range(6):   # laces
        v = 0.35 + i * 0.06
        t.blend(t.band_u(0.44, 0.56, 0.003) * t.band_v(v, v + 0.015, 0.003), (0.97, 0.97, 0.97))
    t.mul(t.band_u(0.42, 0.58, 0.004) * t.band_v(0.3, 0.72, 0.004), 0.85)   # tongue edge shadow
    t.blend(t.gauss(0.5, 0.95, 0.1, 0.06), (0.95, 0.95, 0.95), 0.4)          # toe cap
    t.blend(t.gauss(0.5, 0.02, 0.06, 0.05), (0.97, 0.97, 0.97), 0.5)         # heel tab
    for s in (0.3, 0.7):
        t.blend(t.gauss(s, 0.55, 0.03, 0.15), (0.95, 0.95, 0.95), 0.3)       # side swoosh-ish panel


def leather(t):
    t.a[:] = 0.7
    t.blend(t.gauss(0.5, 0.88, 0.12, 0.08), (1, 1, 1), 0.35)
    t.blend(t.gauss(0.5, 0.1, 0.1, 0.06), (1, 1, 1), 0.2)
    t.mul(sole_mask(t, 0.12), 0.45)
    t.mul(t.band_u(0.45, 0.55, 0.004) * t.band_v(0.35, 0.62, 0.004), 0.8)
    for i in range(4):
        v = 0.38 + i * 0.06
        t.mul(t.band_u(0.46, 0.54, 0.003) * t.band_v(v, v + 0.01, 0.003), 0.6)
    t.noise(0.02, 40)


def boot(t):
    t.a[:] = hexrgb(0x2a2420)
    t.noise(0.06, 40, seed=12)
    t.blend(sole_mask(t, 0.16), hexrgb(0x111111))
    t.blend(t.band_u(0.155, 0.165, 0.002) + t.band_u(0.835, 0.845, 0.002), hexrgb(0xc8a032), 0.8)   # stitching
    for i in range(6):
        v = 0.2 + i * 0.06
        t.blend(t.band_u(0.45, 0.55, 0.003) * t.band_v(v, v + 0.012, 0.003), hexrgb(0x8a6a3a))
    t.blend(t.gauss(0.5, 0.92, 0.12, 0.06), hexrgb(0x55504a), 0.6)   # steel toe scuff


def bare_feet(t):
    t.a[:] = 0.86
    t.noise(0.02, 30, seed=13)
    for i in range(5):   # toes and nails
        u = 0.38 + i * 0.06
        t.mul(t.band_u(u - 0.004, u + 0.004, 0.003) * t.band_v(0.86, 1.05, 0.005), 0.8)
        t.blend(t.gauss(u + 0.03, 0.95, 0.015, 0.02), (0.95, 0.93, 0.92), 0.5)
    t.blend(sole_mask(t, 0.1), (0.94, 0.94, 0.94), 0.5)


def tray(t):
    t.a[:] = hexrgb(0xb8bcc0)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32) - S / 2
    rr = np.sqrt(xx * xx + yy * yy)
    t.a *= (1 + 0.05 * np.sin(rr * 1.7))[..., None]
    t.noise(0.02, 60, seed=2)


# ------------------------------------------------------------------------------------------------ the atlas
def draw(name, kind, idx, pad, skins):
    t = Tile(pad)
    if name.startswith('face_'):
        fem = name[5] == 'f'
        face(t, skins[int(name[6])], fem, idx)
    elif name.startswith('hair_'):
        hair(t, name[5:], idx)
    elif name == 'hat_hard_yellow':
        hard_hat(t, 0xe8c21e)
    elif name == 'hat_hard_white':
        hard_hat(t, 0xeeece6)
    elif name == 'hat_officer':
        officer_hat(t)
    elif name == 'hat_bandana':
        bandana(t)
    elif name == 'hat_beanie':
        beanie(t)
    else:
        fn = {
            'top_tee': top_tee, 'top_polo': top_polo, 'top_shirt': top_shirt, 'top_stripes': top_stripes, 'top_floral': top_floral,
            'top_tank': lambda t: top_tee(t, ringer=True), 'top_blouse': top_blouse, 'top_hoodie': top_hoodie, 'top_blazer': top_blazer,
            'uni_hivis_orange': lambda t: hivis(t, 0xf26522), 'uni_hivis_yellow': lambda t: hivis(t, 0xd4dc1e), 'uni_officer': officer, 'uni_captain': captain,
            'uni_waiter': lambda t: waistcoat(t, 0x15151a, 0x111111), 'uni_dealer': lambda t: waistcoat(t, 0x6a1b2e, 0x6a1b2e), 'uni_chef': chef, 'uni_performer': performer,
            'uni_cleaner': lambda t: tunic(t, 0x3f6f9a), 'uni_coverall': coverall, 'uni_scrubs': scrubs, 'uni_steward': steward, 'uni_host': host, 'uni_pirate': pirate,
            'top_bare': bare, 'top_swim': swimsuit,
            'bot_trousers': trousers, 'bot_jeans': jeans, 'bot_chinos': chinos, 'bot_hivis': hivis_trousers, 'bot_coverall': coverall_trousers, 'bot_uniform': uniform_trousers, 'bot_swim': swim_shorts,
            'shoe_sneaker': sneaker, 'shoe_leather': leather, 'shoe_boot': boot, 'shoe_bare': bare_feet,
            'plain': lambda t: None, 'prop_tray': tray,
        }[name]
        if name == 'plain':
            t.a[:] = 1.0
        else:
            fn(t)
    a = np.clip(t.a, 0, 1)
    if kind == 'tint':   # neutral grey: no colour cast, so the per-person colour multiplies cleanly
        g = a.mean(axis=2, keepdims=True)
        a = np.repeat(g, 3, axis=2)
    return a


def main():
    layout = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    pad, skins, grid = layout['pad'], layout['skins'], layout['grid']
    big = np.zeros((grid * S, grid * S, 3), np.float32)
    means = []
    for i, tl in enumerate(layout['tiles']):
        a = draw(tl['name'], tl['kind'], i, pad, skins)
        r, c = divmod(i, grid)
        big[r * S:(r + 1) * S, c * S:(c + 1) * S] = a
        lo, hi = int(pad * S), int((1 - pad) * S)
        m = (a[lo:hi, lo:hi].mean(axis=(0, 1)) * 255).round().astype(int)
        means.append(int(m[0]) << 16 | int(m[1]) << 8 | int(m[2]))
        print(f"{i:2d} {tl['name']:<18} {tl['kind']:<4} mean #{means[-1]:06x}", flush=True)
    img = Image.fromarray((big * 255).round().astype(np.uint8), 'RGB')
    img.resize((grid * S // 2, grid * S // 2), Image.LANCZOS).save(f'{out}/albedo.png')
    img.resize((grid * S // 4, grid * S // 4), Image.LANCZOS).save(f'{out}/albedo_512.png')
    json.dump({'means': means}, open(f'{out}/means.json', 'w'))


if __name__ == '__main__':
    main()
