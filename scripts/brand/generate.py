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

and, for the website (apps/web/public/):
- brand/logo@2x.png, @3x  the mark with "CampusRide" beside it, for the header
  (32 px tall); brand/logo-white@2x.png, @3x the same, all white, for the footer
- favicon.ico (16, 32, 48), apple-touch-icon.png (180), brand/icon-192.png and
  brand/icon-512.png (web app manifest): the rider app's icon
- og-image.png  1200 x 630, the picture shown when a link is shared (WhatsApp,
  Facebook, X): the logo, a headline and the welcome animation's last frame

The background colours must match each app.json (icon background is baked in
here; the adaptive-icon and splash backgrounds are set there).
docs/runbooks/releasing.md, "App icons and splash", says how they are used.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

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

WEB = ROOT / "apps" / "web" / "public"
# The header logo's height on the page, in CSS px.
WEB_LOGO_HEIGHT = 32
FIGTREE = ROOT / "node_modules" / "@expo-google-fonts" / "figtree"
WELCOME_STILL = ROOT / "packages" / "mobile-shared" / "assets" / "welcome" / "welcome-end@3x.png"
OG_SIZE = (1200, 630)
OG_HEADLINE = "Rides around the University of Ghana, Legon"
OG_SUBLINE = "Share a car or ride alone. Fixed fares, paid in cash."


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


def split_logo(logo: Image.Image) -> tuple[Image.Image, Image.Image]:
    """logo-name.png's mark and its "CampusRide" wordmark, each cropped close."""
    alpha = logo.getchannel("A")
    rows = [alpha.crop((0, y, logo.width, y + 1)).getbbox() is not None for y in range(logo.height)]
    # The first empty row after the mark starts the gap above the wordmark.
    gap = rows.index(False)
    mark, word = logo.crop((0, 0, logo.width, gap)), logo.crop((0, gap, logo.width, logo.height))
    return mark.crop(mark.getbbox()), word.crop(word.getbbox())


def lockup(logo: Image.Image, height: int) -> Image.Image:
    """The mark with the wordmark beside it, `height` px tall."""
    mark, word = split_logo(logo)
    mark = scaled(mark, height / mark.height)
    # Cap height to baseline is about 3/4 of the wordmark's box ("p" hangs below):
    # that band is centred on the mark, at 46% of its height.
    word = scaled(word, height * 0.46 / (word.height * 0.75))
    gap = round(height * 0.24)
    canvas = Image.new("RGBA", (mark.width + gap + word.width, height), (0, 0, 0, 0))
    canvas.paste(mark, (0, 0), mark)
    top = round((height - word.height * 0.75) / 2)
    canvas.paste(word, (mark.width + gap, top), word)
    return canvas


def rounded(image: Image.Image, share: float) -> Image.Image:
    """The image with transparent rounded corners (radius `share` of its width)."""
    mask = Image.new("L", (image.width * 4, image.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, mask.width - 1, mask.height - 1), radius=round(mask.width * share), fill=255
    )
    out = image.convert("RGBA")
    out.putalpha(mask.resize(image.size, Image.LANCZOS))
    return out


def og_image(logo_white: Image.Image) -> Image.Image:
    """Logo and headline over a road running the width of the picture, with the
    welcome animation's library and car on the right."""
    width, height = OG_SIZE
    canvas = Image.new("RGB", OG_SIZE, BACKGROUNDS["rider"])
    # The still is the welcome screen's last frame (the 1080 x 1920 composition
    # at 1.2x): sky, logo, then the library, car and road at the bottom. Keep
    # the scene and drop the sky and the logo. Positions as in WelcomeHero.tsx.
    still = Image.open(WELCOME_STILL).convert("RGBA")
    comp = still.width / 1080
    top = round(still.height * 0.52)
    scene = still.crop((0, top, still.width, still.height))
    factor = 400 / scene.height
    scene = scaled(scene, factor)
    road_top = height - round((still.height - 1621 * comp) * factor)
    scene_x = width - scene.width - 24

    draw = ImageDraw.Draw(canvas)
    # The road, the full width, with its dashes in step with the scene's.
    draw.rectangle((0, road_top, width, height), fill="#333333")
    unit = comp * factor
    dash_top = road_top + (1773 - 1621) * unit
    period, length = 121.625 * unit, 60 * unit
    x = scene_x + 63 * unit
    while x > 0:
        x -= period
    while x < width:
        draw.rectangle((x, dash_top, x + length, dash_top + 24 * unit), fill="#FFFFFF")
        x += period
    canvas.paste(scene, (scene_x, height - scene.height), scene)

    left = 64
    logo = lockup(logo_white, 64)
    canvas.paste(logo, (left, 64), logo)
    bold = ImageFont.truetype(str(FIGTREE / "800ExtraBold" / "Figtree_800ExtraBold.ttf"), 54)
    medium = ImageFont.truetype(str(FIGTREE / "500Medium" / "Figtree_500Medium.ttf"), 26)
    lines, line = [], ""
    for word in OG_HEADLINE.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=bold) > 640 and line:
            lines.append(line)
            line = word
        else:
            line = trial
    lines.append(line)
    y = 186
    for text in lines:
        draw.text((left, y), text, font=bold, fill="#FFFFFF")
        y += 64
    draw.text((left, y + 14), OG_SUBLINE, font=medium, fill="#DDF0E3")
    return canvas


def website() -> None:
    """The website's logo, icons and link preview picture (apps/web/public)."""
    logo = load("logo-name.png")
    brand = WEB / "brand"
    brand.mkdir(parents=True, exist_ok=True)
    outputs: dict[Path, Image.Image] = {}
    # The header logo loads with every page: two colours and their edges fit a
    # 64-colour palette, at a sixth of the size.
    def small(image: Image.Image) -> Image.Image:
        return image.quantize(colors=64, method=Image.Quantize.FASTOCTREE)

    for density in (2, 3):
        outputs[brand / f"logo@{density}x.png"] = small(lockup(logo, WEB_LOGO_HEIGHT * density))
        outputs[brand / f"logo-white@{density}x.png"] = small(
            all_white(lockup(logo, WEB_LOGO_HEIGHT * density))
        )

    mark = load("logo-white.png")
    app_icon = icon(mark, BACKGROUNDS["rider"], ICON)
    outputs[WEB / "apple-touch-icon.png"] = app_icon.resize((180, 180), Image.LANCZOS)
    for size in (192, 512):
        # Manifest icons may be cropped to a circle (maskable): the mark stays in the safe zone.
        outputs[brand / f"icon-{size}.png"] = app_icon.resize((size, size), Image.LANCZOS)
    outputs[WEB / "og-image.png"] = og_image(all_white(logo))

    for path, image in outputs.items():
        image.save(path, optimize=True)
        print(f"{path.relative_to(ROOT)}  {image.width}x{image.height} {image.mode}")

    favicon = rounded(app_icon.resize((256, 256), Image.LANCZOS), 0.22)
    path = WEB / "favicon.ico"
    favicon.save(path, sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"{path.relative_to(ROOT)}  16, 32, 48")


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

    website()


if __name__ == "__main__":
    main()
