#!/usr/bin/env python3
"""
Every app icon, splash image, notification icon and store icon, made from the
designer's logo files in assets/brand/. Re-run after changing those files:

    python3 -m pip install Pillow    # once
    python3 scripts/brand/generate.py

Sources (assets/brand/, copied as they came from the designer):
- logo-white.png  the mark alone, white on transparent
- logo-green.png  the mark alone, brand green
- logo-name.png   the mark with "CampusRide" stacked under it, grey + green

Writes, for each app (rider on brand green, driver on near-black):
- apps/<app>/assets/icon.png            1024 x 1024, no transparency (iOS)
- apps/<app>/assets/adaptive-icon.png   1024 x 1024, transparent (Android foreground)
- apps/<app>/assets/notification-icon.png  96 x 96, white on transparent
- apps/<app>/assets/splash-icon.png     1024 x 1024, the logo with its name, all white
- store-assets/<app>/play-icon-512.png  512 x 512, as icon.png (Google Play listing)

and, inside the apps (packages/mobile-shared, both apps):
- assets/illustrations/logo-mark.png (+ @2x, @3x)  the green mark at 72 pt, for
  the white loading screen (LoadingState)

The background colours must match each app.json (icon background is baked in
here; the adaptive-icon and splash backgrounds are set there).
docs/runbooks/releasing.md, "App icons and splash", says how they are used.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets" / "brand"

BACKGROUNDS = {
    "rider": "#19743C",  # green-500, the brand green
    "driver": "#0F1311",  # ink, so the two apps look different on a phone
}

ICON = 1024
# The mark's width on the iOS icon, as a share of the icon.
ICON_MARK_SHARE = 0.60
# Android crops the adaptive icon to a circle, square or squircle: the art must
# sit inside a centred circle this share of the canvas across (the 66 dp safe
# zone of 108 dp is 61%).
ADAPTIVE_SAFE_SHARE = 0.60
NOTIFICATION = 96
# Android draws notification icons in a 22 dp live area of a 24 dp square.
NOTIFICATION_LIVE_SHARE = 22 / 24
# Space left around the logo on the splash image ("cropped close").
SPLASH_MARGIN = 8
PLAY_ICON = 512
# LoadingState draws the mark 72 pt square, on white.
IN_APP_MARK = 72
IN_APP_MARK_DIR = ROOT / "packages" / "mobile-shared" / "assets" / "illustrations"


def load(name: str) -> Image.Image:
    image = Image.open(BRAND / name).convert("RGBA")
    return image.crop(image.getchannel("A").getbbox())


def scaled(image: Image.Image, factor: float) -> Image.Image:
    size = (round(image.width * factor), round(image.height * factor))
    return image.resize(size, Image.LANCZOS)


def centred(canvas: Image.Image, art: Image.Image) -> Image.Image:
    x = (canvas.width - art.width) // 2
    y = (canvas.height - art.height) // 2
    canvas.paste(art, (x, y), art)
    return canvas


def all_white(image: Image.Image) -> Image.Image:
    """Every pixel white, keeping its transparency (the anti-aliased edges too)."""
    white = Image.new("RGBA", image.size, (255, 255, 255, 255))
    white.putalpha(image.getchannel("A"))
    return white


def farthest_reach(image: Image.Image) -> float:
    """How far the furthest visible pixel is from the image's centre."""
    alpha = image.getchannel("A")
    cx, cy = image.width / 2, image.height / 2
    reach = 0.0
    pixels = alpha.load()
    for y in range(image.height):
        for x in range(image.width):
            if pixels[x, y] > 0:
                reach = max(reach, ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5)
    return reach


def icon(mark: Image.Image, background: str, size: int) -> Image.Image:
    art = scaled(mark, size * ICON_MARK_SHARE / mark.width)
    # RGB, not RGBA: the App Store refuses an icon with an alpha channel.
    return centred(Image.new("RGB", (size, size), background), art)


def main() -> None:
    mark = load("logo-white.png")
    logo = all_white(load("logo-name.png"))

    adaptive_art = scaled(mark, (ICON * ADAPTIVE_SAFE_SHARE / 2) / farthest_reach(mark))
    notification_art = scaled(
        mark, NOTIFICATION * NOTIFICATION_LIVE_SHARE / max(mark.width, mark.height)
    )
    splash_art = scaled(logo, (ICON - 2 * SPLASH_MARGIN) / logo.width)

    def clear(size: int) -> Image.Image:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))

    for app, background in BACKGROUNDS.items():
        assets = ROOT / "apps" / app / "assets"
        store = ROOT / "store-assets" / app
        store.mkdir(parents=True, exist_ok=True)

        outputs = {
            assets / "icon.png": icon(mark, background, ICON),
            assets / "adaptive-icon.png": centred(clear(ICON), adaptive_art),
            assets / "notification-icon.png": centred(clear(NOTIFICATION), notification_art),
            assets / "splash-icon.png": centred(clear(ICON), splash_art),
            store / "play-icon-512.png": icon(mark, background, PLAY_ICON),
        }
        for path, image in outputs.items():
            image.save(path, optimize=True)
            print(f"{path.relative_to(ROOT)}  {image.width}x{image.height} {image.mode}")

    green = load("logo-green.png")
    for density in (1, 2, 3):
        size = IN_APP_MARK * density
        art = scaled(green, size / max(green.width, green.height))
        suffix = "" if density == 1 else f"@{density}x"
        path = IN_APP_MARK_DIR / f"logo-mark{suffix}.png"
        centred(clear(size), art).save(path, optimize=True)
        print(f"{path.relative_to(ROOT)}  {size}x{size} RGBA")


if __name__ == "__main__":
    main()
