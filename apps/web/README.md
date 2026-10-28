# CampusRide website (apps/web)

The public site at https://campusride.app: home page, privacy policy, terms,
support and account deletion. Plain HTML and CSS with no dependencies and no
install step. Deployed as the Render static site `campusride-web`
(`render.yaml`; first deploy, domains and headers: `docs/runbooks/website.md`).

```sh
npm run build --workspace=apps/web   # writes apps/web/dist
npm test --workspace=apps/web        # builds into a temp folder and checks it
```

Open `dist/index.html` through any static server to preview (the pages use
`/styles.css`-style paths, so opening the file directly loses the styles).

Every page works without JavaScript. The one script (`public/app.js`, home
page only) plays the apps' welcome animation in the hero phone with
lottie-web (`public/vendor/`, MIT); without it, with Reduce Motion or Data
Saver on, the phone shows the animation's last frame. The FAQ is `<details>`.

## Read from the code at build time

So the site can't say something the apps and server don't do, `build.mjs` reads:

| What | From |
|---|---|
| Fares, riders per shared car, commission | `PRICING` in `packages/shared/src/pricing/pricing.ts` (the build fails if the shared fare stops being one fare per rider, because the copy says so) |
| Pickup areas ("Where we operate", the map) | `REAL_ZONE_CENTRES` less `RETIRED_ZONES` in `apps/server/src/scripts/realignZones.ts` |
| Roads on the map | `assets/map/legon-osm.json` (OpenStreetMap; `node scripts/map/fetch-legon.mjs` refreshes it) |
| The hero animation | `packages/mobile-shared/assets/welcome/welcome.json` |
| Account-deletion retention, "Last updated" date | `@rida/shared` (see below) |

## Where things are

| File | What |
|---|---|
| `site.config.mjs` | Operator's name and address, support phone and email, **store links**, which pages show **DRAFT FOR LEGAL REVIEW**, the email-deletion time limit. A `null` shows on the page as a highlighted `[PLACEHOLDER]` (and fails the tests). |
| `src/pages/*.html` | Each page's content. `{{name}}` is filled in by `build.mjs` (an unknown name fails the build). |
| `src/layout.html` | The shared `<head>` (title, description, canonical, Open Graph), header and footer. |
| `src/screens.json` | The app screenshots on the home page: harness scene, alt text, and the prices they were made with. |
| `build.mjs` | The page list (titles and descriptions for SEO), the map, the phone frames, store links, JSON-LD, sitemap and robots.txt. |
| `public/styles.css` | All styling. Brand colours and radii at the top. No inline styles anywhere: the Content-Security-Policy forbids them. |
| `public/brand/`, `favicon.ico`, `apple-touch-icon.png`, `og-image.png` | Logo, icons and the link preview picture, made from `assets/brand/` by `python3 scripts/brand/generate.py`. Don't edit them by hand. |
| `public/screens/` | The screenshots, made by `python3 apps/web/tools/screenshots.py`. |
| `public/fonts/` | Figtree (SIL Open Font Licence, `OFL.txt`). |
| `public/badges/` | Apple's and Google's official store badges, unchanged. |

## Store links

`stores` in `site.config.mjs` has an App Store and a Google Play address for
each app, all `""` for now. Apple and Google allow their badges only for apps
people can download, so an empty one shows **Coming soon to the App Store and
Google Play** in plain text. Paste a listing's address and that store's
official badge appears, linked (the App Store badge first, as Apple asks), with
the stores' trademark line in the footer.

## Screenshots

`python3 apps/web/tools/screenshots.py` renders each scene in
`src/screens.json` with the screenshot harness (`scripts/screens`,
`--map-art`: the map is drawn from the real Legon roads) and saves 320 and
640 px wide WebPs. Re-run it when a screen changes, and after a price change:
the tests compare the prices it recorded with today's and fail until it's run.
The build itself fails if any screenshot a phone frame uses is missing, the
wrong size, or blank (`checkScreens` in `build.mjs`), and the tool refuses a
scene that rendered as one flat colour.
Nothing on the page is invented except the harness's sample people (Ama,
Kwame, Kofi) and trip times.

## The draft banner

`draftPages` in `site.config.mjs` lists the pages that show **DRAFT FOR LEGAL
REVIEW**. It's empty (turned off 2026-10-18); add `"privacy"` or `"terms"` to
show it again. The test that pins the list to `[]` needs the same change.

## Changing the privacy policy or the terms

The "Last updated" date on both pages is `TERMS_VERSION` in
`packages/shared/src/account/terms.ts` (as `YYYY-MM-DD`). Change it there
whenever either page changes: the apps record that version when someone ticks
"I'm 18 or older and I agree to the Terms and Privacy Policy", so the account
says which wording they agreed to.

## Keeping it true

The privacy policy and the deletion page describe what the code does
(source: `docs/store/data-inventory.md`). The deletion page reads the
retention period from `@rida/shared`, and the tests fail if the app's delete
button labels or the server's purge fields change. Anything else the apps
start collecting has to be added to the inventory and the policy by hand.
