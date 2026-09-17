#!/usr/bin/env python3
"""Generate the extension's PNG icons with no third-party dependencies.

Draws the same mark used in the side panel header: a rounded orange square
(Swiggy-ish) with a white document sheet and an orange tick on it.
"""
import os
import struct
import zlib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "extension", "assets")

BG_TOP = (252, 128, 25)
BG_BOT = (226, 108, 7)
SHEET = (255, 255, 255)
TICK = (226, 108, 7)
TRANSPARENT = (0, 0, 0, 0)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw(size):
    px = [[TRANSPARENT] * size for _ in range(size)]
    radius = max(2, int(size * 0.22))

    # Sheet geometry, in fractions of the canvas.
    sx0, sx1 = int(size * 0.28), int(size * 0.72)
    sy0, sy1 = int(size * 0.24), int(size * 0.76)

    for y in range(size):
        t = y / max(1, size - 1)
        bg = lerp(BG_TOP, BG_BOT, t) + (255,)
        for x in range(size):
            # Rounded-rectangle mask.
            dx = max(radius - x, x - (size - 1 - radius), 0)
            dy = max(radius - y, y - (size - 1 - radius), 0)
            if dx * dx + dy * dy > radius * radius:
                continue
            px[y][x] = bg

    # Document sheet with a folded top-right corner.
    fold = max(2, int(size * 0.11))
    for y in range(sy0, sy1):
        for x in range(sx0, sx1):
            in_fold = x >= sx1 - fold and y <= sy0 + fold
            if in_fold and (x - (sx1 - fold)) + ((sy0 + fold) - y) > fold:
                continue
            px[y][x] = SHEET + (255,)

    # Three "text" rules on the sheet.
    rule_h = max(1, int(size * 0.035))
    for i, frac in enumerate((0.42, 0.53, 0.64)):
        ry = int(size * frac)
        rx1 = sx1 - int(size * (0.10 if i == 2 else 0.08))
        for y in range(ry, min(ry + rule_h, sy1 - 2)):
            for x in range(sx0 + int(size * 0.07), rx1):
                px[y][x] = (214, 219, 227, 255)

    # Tick, drawn thick enough to survive 16px.
    thick = max(1, int(size * 0.055))
    pts = []
    ax, ay = sx0 + int(size * 0.10), int(size * 0.50)
    bx, by = sx0 + int(size * 0.19), int(size * 0.60)
    cx, cy = sx1 - int(size * 0.09), int(size * 0.36)
    for seg in (((ax, ay), (bx, by)), ((bx, by), (cx, cy))):
        (x0, y0), (x1, y1) = seg
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for s in range(steps + 1):
            pts.append((x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps))
    for cxp, cyp in pts:
        for dy in range(-thick, thick + 1):
            for dx in range(-thick, thick + 1):
                if dx * dx + dy * dy > thick * thick:
                    continue
                xi, yi = int(round(cxp)) + dx, int(round(cyp)) + dy
                if sy0 <= yi < sy1 and sx0 <= xi < sx1:
                    px[yi][xi] = TICK + (255,)

    return px


def write_png(path, px):
    size = len(px)
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("4B", *p) for p in row) for row in px
    )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(OUT, f"icon{size}.png")
        write_png(path, draw(size))
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
