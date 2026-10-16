# CampusRide website (apps/web)

The public site at https://campusride.app: landing page, privacy policy,
terms, support and account deletion. Plain HTML and CSS, no JavaScript on the
pages, no dependencies. Deployed as the Render static site `campusride-web`
(`render.yaml`; first deploy and domains: `docs/runbooks/website.md`).

```sh
npm run build --workspace=apps/web   # writes apps/web/dist
npm test --workspace=apps/web        # builds into a temp folder and checks it
```

Open `dist/index.html` through any static server to preview (the pages use
`/styles.css`-style paths, so opening the file directly loses the styles).

## Where things are

| File | What |
|---|---|
| `site.config.mjs` | Operator's name and address, support phone and email, the "last updated" date, which pages show **DRAFT FOR LEGAL REVIEW**, the email-deletion time limit. A `null` shows on the page as a highlighted `[PLACEHOLDER]`. |
| `src/pages/*.html` | Each page's content. `{{name}}` is filled in from the config (an unknown name fails the build). |
| `src/layout.html` | The shared `<head>` (title, description, canonical, Open Graph), header and footer. |
| `build.mjs` | The page list (titles and descriptions for SEO), sitemap and robots.txt. |
| `public/logo.svg` | **The logo**, used in the header and footer. Placeholder text wordmark until the real logo exists: replace this one file. If the new one has a different shape, update the `width`/`height` on its two `<img>` tags in `src/layout.html`. |
| `public/favicon.svg` | Browser-tab icon (placeholder). |
| `public/og-image.png` | 1200×630 picture shown when a link is shared on WhatsApp, Facebook, X. Replace it with a designed one when the logo exists. |
| `public/styles.css` | All styling. Brand colours at the top. |

## Removing the draft banner

When a lawyer has reviewed the privacy policy or the terms, take that page out
of `draftPages` in `site.config.mjs` (and update `legalLastUpdated`). The
test that pins the list to `["privacy", "terms"]` needs the same change.

## Keeping it true

The privacy policy and the deletion page describe what the code does
(source: `docs/store/data-inventory.md`). The deletion page reads the
retention period from `@rida/shared`, and the tests fail if the app's delete
button labels or the server's purge fields change. Anything else the apps
start collecting has to be added to the inventory and the policy by hand.
