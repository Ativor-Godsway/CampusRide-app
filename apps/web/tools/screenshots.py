#!/usr/bin/env python3
"""
The app screenshots on the home page, made with the screenshot harness
(scripts/screens) from the apps' real screens. Re-run after a screen in
src/screens.json changes, or after a price change (the tests ask for it):

    python3 -m pip install Pillow    # once
    python3 apps/web/tools/screenshots.py

For each entry in src/screens.json it renders the harness scene with
`--map-art` (real Legon roads on the map, from OpenStreetMap), writes it as
public/screens/<name>-320.webp and -640.webp (the page frames it in an iPhone
drawn in CSS), and records the prices the pictures show under "madeWith".
"""

import json
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parents[3]
WEB = ROOT / "apps" / "web"
LIST = WEB / "src" / "screens.json"
OUT = WEB / "public" / "screens"
WIDTHS = (320, 640)
QUALITY = 82


def pricing() -> dict:
    """PRICING, read by the website build (the same reading the page uses)."""
    script = "import('./apps/web/build.mjs').then((m) => console.log(JSON.stringify(m.readPricing())))"
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=ROOT, check=True, capture_output=True, text=True
    )
    return json.loads(out.stdout)


def main() -> None:
    listing = json.loads(LIST.read_text())
    screens = listing["screens"]
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for app in sorted({s["app"] for s in screens}):
            scenes = ",".join(s["scene"] for s in screens if s["app"] == app)
            subprocess.run(
                ["npm", "run", "screens", "--", "web", "--map-art", "--app", app, "--only", scenes, "--out", tmp],
                cwd=ROOT,
                check=True,
            )
        wanted = set()
        for screen in screens:
            source = Path(tmp) / "web" / f"{screen['app']}-{screen['scene']}.png"
            if not source.exists():
                sys.exit(f"The harness made no {source.name}: is the scene name right?")
            image = Image.open(source).convert("RGB")
            # A scene that failed to render is one flat colour: never ship an empty phone.
            if max(ImageStat.Stat(image).stddev) < 8:
                sys.exit(f"{source.name} came out blank: check the scene in scripts/screens/harness")
            for width in WIDTHS:
                height = round(image.height * width / image.width)
                path = OUT / f"{screen['name']}-{width}.webp"
                image.resize((width, height), Image.LANCZOS).save(path, quality=QUALITY, method=6)
                wanted.add(path.name)
                print(f"{path.relative_to(ROOT)}  {path.stat().st_size // 1024} KB")
    for old in OUT.glob("*.webp"):
        if old.name not in wanted:
            old.unlink()
            print(f"removed {old.relative_to(ROOT)}")

    listing["madeWith"] = {**pricing(), "date": date.today().isoformat()}
    LIST.write_text(json.dumps(listing, indent=2, ensure_ascii=False) + "\n")
    print(f"{LIST.relative_to(ROOT)}: madeWith {listing['madeWith']}")


if __name__ == "__main__":
    main()
