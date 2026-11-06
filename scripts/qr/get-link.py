#!/usr/bin/env python3
"""
The QR code for flyers and posters: https://campusride.app/get?src=flyer,
which sends iPhones to the App Store, Android phones to Google Play and
everything else to a page with both (apps/web, getPage in build.mjs).

    python3 -m pip install segno    # once
    python3 scripts/qr/get-link.py               # src=flyer
    python3 scripts/qr/get-link.py poster        # src=poster, for a new source

Black on white, error correction level H (still scans with 30% of it
damaged or covered, so it survives small prints and smudges), with the
standard four-module quiet zone. Writes, in assets/qr/:
- get-<src>.svg  vector, for print: scales to any size
- get-<src>.png  at least 2000 x 2000 px
"""
import math
import pathlib
import re
import sys

import segno

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "qr"
MIN_PNG_PX = 2000
BORDER = 4

src = sys.argv[1] if len(sys.argv) > 1 else "flyer"
# The same rule as /get.js: other names aren't passed on to the stores.
if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", src):
    sys.exit("src must be letters, digits, - or _ (up to 40)")

url = f"https://campusride.app/get?src={src}"
qr = segno.make(url, error="h", micro=False, boost_error=False)
modules = qr.symbol_size(scale=1, border=BORDER)[0]
scale = math.ceil(MIN_PNG_PX / modules)

OUT.mkdir(parents=True, exist_ok=True)
qr.save(OUT / f"get-{src}.svg", kind="svg", border=BORDER, dark="#000000", light="#ffffff", scale=10, title=url, xmldecl=False, svgclass=None, lineclass=None)
qr.save(OUT / f"get-{src}.png", kind="png", border=BORDER, dark="#000000", light="#ffffff", scale=scale)
print(f"{url}: version {qr.version}, level {qr.error}, {modules * scale} px PNG -> {OUT.relative_to(ROOT)}")
