#!/usr/bin/env python3
"""Generate a minimal HornScribe app icon (pure stdlib PNG writer).

Design: dark surface, faint 5-line staff, brand-blue note head + stem.
256x256 RGB PNG suitable as input for `tauri icon` or direct bundling.
"""
import struct
import zlib
import sys

W = H = 256
BG = (31, 31, 31)        # --hs-surface-app dark
STAFF = (74, 78, 84)     # faint staff lines
NOTE = (15, 108, 189)    # --hs-accent (Fluent brand 80)

px = [[BG for _ in range(W)] for _ in range(H)]


def rect(x0, y0, x1, y1, c):
    for y in range(max(0, y0), min(H, y1)):
        row = px[y]
        for x in range(max(0, x0), min(W, x1)):
            row[x] = c


def ellipse(cx, cy, rx, ry, c):
    for y in range(max(0, cy - ry), min(H, cy + ry + 1)):
        for x in range(max(0, cx - rx), min(W, cx + rx + 1)):
            dx = (x - cx) / rx
            dy = (y - cy) / ry
            if dx * dx + dy * dy <= 1.0:
                px[y][x] = c


# staff lines (spike proportions)
for ly in (96, 112, 128, 144, 160):
    rect(40, ly, 216, ly + 3, STAFF)

# eighth note: head + stem + flag
ellipse(110, 152, 22, 16, NOTE)
rect(126, 60, 134, 152, NOTE)          # stem
rect(126, 60, 168, 76, NOTE)           # flag beam stub
rect(160, 76, 168, 96, NOTE)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


raw = b"".join(
    b"\x00" + b"".join(bytes(p) for p in row) for row in px
)
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)

out = sys.argv[1] if len(sys.argv) > 1 else "icon.png"
with open(out, "wb") as f:
    f.write(png)
print(f"wrote {out} ({len(png)} bytes)")
