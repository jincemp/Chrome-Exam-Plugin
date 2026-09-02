#!/usr/bin/env python3
"""Generate the extension's PNG icons with no third-party dependencies.

Two sets are produced, both grey line art on a transparent background:
  icons/icon{16,32,48,128}.png       idle  - an answer list
  icons/icon-done{16,32,48,128}.png  ready - a checkmark

Nothing is filled behind the mark, so the icon sits on whatever the browser's
toolbar happens to be. That rules out a coloured state signal, so idle and ready
differ by shape - and the badge carries the count on top.

The ink is one mid grey deliberately: Chrome does not re-tint extension icons
for dark mode, so a single value has to clear ~3.5:1 against both a white
toolbar and Chrome's dark one (#292a2d). Darker greys read better on white and
vanish on dark; this one is close to the balance point for the two.

Rendering is done by supersampled signed-distance evaluation, so the shapes come
out smooth at every size. Run with:  python3 tools/make_icons.py
"""

import math
import os
import struct
import zlib

SS = 4  # supersampling factor per axis

INK = (0x7E, 0x84, 0x8C)  # 3.8:1 on a white toolbar, 3.8:1 on Chrome's dark one

# ---------------------------------------------------------------- primitives


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


# ---------------------------------------------------------------- the artwork


def sample(u, v, done, feather):
    """Alpha for the unit-square point (u, v). The colour is INK throughout."""
    if done:
        # A checkmark: in from the left, down to the low point, up to the right.
        # Drawn a touch heavier than the list's bars - one lone diagonal on an
        # empty canvas reads lighter than three stacked rows at the same weight.
        a = coverage(segment_sd(u, v, 0.155, 0.520, 0.395, 0.775, 0.080), feather)
        b = coverage(segment_sd(u, v, 0.395, 0.775, 0.855, 0.235, 0.080), feather)
        return max(a, b)

    # Three answer rows. Without a card behind them these run nearly edge to
    # edge; at 16px that is the difference between a list and a grey smudge.
    mark = 0.0
    for y, right in ((0.220, 0.820), (0.500, 0.860), (0.780, 0.700)):
        dot = coverage(circle_sd(u, v, 0.165, y, 0.078), feather)
        bar = coverage(segment_sd(u, v, 0.395, y, right, y, 0.062), feather)
        mark = max(mark, dot, bar)
    return mark


def render(size, done):
    """Render one icon as raw RGBA bytes."""
    # Roughly one device pixel of edge softness whatever the size. A fixed
    # fraction of the canvas instead would blur the 128px icon and leave the
    # 16px one ragged.
    feather = 1.15 / size
    rows = []
    inv = 1.0 / (size * SS)
    weight = 1.0 / (SS * SS)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            a = 0.0
            for sy in range(SS):
                v = (y * SS + sy + 0.5) * inv
                for sx in range(SS):
                    u = (x * SS + sx + 0.5) * inv
                    a += sample(u, v, done, feather)
            a *= weight
            row += bytes(INK)
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
