#!/usr/bin/env python3
"""Generate the extension's PNG icons with no third-party dependencies.

Two sets are produced:
  icons/icon{16,32,48,128}.png       idle  - indigo card with a multiple-choice list
  icons/icon-done{16,32,48,128}.png  ready - green card with a checkmark

Rendering is done by supersampled signed-distance evaluation, so the shapes come
out smooth at every size. Run with:  python3 tools/make_icons.py
"""

import math
import os
import struct
import zlib

SS = 4  # supersampling factor per axis

# ---------------------------------------------------------------- primitives


def rounded_rect_sd(px, py, cx, cy, hw, hh, r):
    """Signed distance to a rounded rectangle (negative inside)."""
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    ox, oy = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r


def segment_sd(px, py, ax, ay, bx, by, half_w):
    """Signed distance to a thick line segment with round caps."""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    return math.hypot(wx - t * vx, wy - t * vy) - half_w


def circle_sd(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def coverage(sd, feather):
    """Signed distance -> alpha in [0, 1]."""
    return max(0.0, min(1.0, 0.5 - sd / feather))


def over(dst, src, alpha):
    """Source-over composite of an opaque colour onto an opaque background."""
    return tuple(int(round(s * alpha + d * (1 - alpha))) for s, d in zip(src, dst))


# ---------------------------------------------------------------- the artwork


def shade(t, top, bottom):
    """Vertical linear gradient between two RGB colours."""
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(top, bottom))


def sample(u, v, done):
    """Colour + alpha for the unit-square point (u, v). Returns (rgb, alpha)."""
    feather = 1.0 / (64.0 * SS) * 6  # ~1.5 device px of softness at any size

    if done:
        top, bottom = (0x1F, 0xB2, 0x6B), (0x0E, 0x8C, 0x52)
    else:
        top, bottom = (0x5B, 0x63, 0xF5), (0x3B, 0x3F, 0xC7)

    bg_sd = rounded_rect_sd(u, v, 0.5, 0.5, 0.5, 0.5, 0.235)
    bg_a = coverage(bg_sd, feather)
    if bg_a <= 0.0:
        return (0, 0, 0), 0.0

    rgb = shade(v, top, bottom)
    ink = (0xFF, 0xFF, 0xFF)

    if done:
        # A bold checkmark.
        a = coverage(segment_sd(u, v, 0.265, 0.520, 0.435, 0.685, 0.072), feather)
        b = coverage(segment_sd(u, v, 0.435, 0.685, 0.740, 0.330, 0.072), feather)
        mark = max(a, b)
    else:
        # Three answer rows; the middle one is "selected".
        mark = 0.0
        rows = ((0.300, 0.760), (0.500, 0.800), (0.700, 0.640))
        for i, (y, right) in enumerate(rows):
            bullet_r = 0.070 if i == 1 else 0.058
            bullet = coverage(circle_sd(u, v, 0.255, y, bullet_r), feather)
            if i != 1:
                ring = coverage(circle_sd(u, v, 0.255, y, bullet_r - 0.030), feather)
                bullet = max(0.0, bullet - ring)
            bar = coverage(segment_sd(u, v, 0.395, y, right, y, 0.052), feather)
            mark = max(mark, bullet, bar)

    if mark > 0.0:
        rgb = over(rgb, ink, mark)

    return rgb, bg_a


def render(size, done):
    """Render one icon as raw RGBA bytes."""
    rows = []
    inv = 1.0 / (size * SS)
    weight = 1.0 / (SS * SS)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                v = (y * SS + sy + 0.5) * inv
                for sx in range(SS):
                    u = (x * SS + sx + 0.5) * inv
                    (cr, cg, cb), ca = sample(u, v, done)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            r, g, b, a = r * weight, g * weight, b * weight, a * weight
            if a > 0.0:  # un-premultiply
                row += bytes((int(round(r / a)), int(round(g / a)), int(round(b / a))))
            else:
                row += b"\x00\x00\x00"
            row.append(int(round(a * 255)))
        rows.append(bytes(row))
    return rows


# ---------------------------------------------------------------- PNG writer


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)  # filter type 0 per scanline
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(here, "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        for done in (False, True):
            name = "icon-done%d.png" % size if done else "icon%d.png" % size
            write_png(os.path.join(out, name), size, render(size, done))
            print("wrote icons/" + name)


if __name__ == "__main__":
    main()
