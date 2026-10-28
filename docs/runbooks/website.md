# Website: deploy and domain move

How to put the new website (`apps/web`) live at **https://campusride.app**,
move the old v1 site to **https://v1.campusride.app**, and keep v1 out of
search results. Written for the owner; every step is by hand in a browser.
Added 2026-10-16.

**Where things are today** (checked with public DNS lookups on 2026-10-16):

| Name | Points at | Host |
|---|---|---|
| `campusride.app` | A record `216.198.79.1` | Vercel (v1), redirects to www |
| `www.campusride.app` | CNAME `…vercel-dns-017.com` | Vercel (v1) |
| `api.campusride.app` | CNAME `campusride-server-eu.onrender.com` | Render API: **don't touch** |
| Mail (`MX`) | `eforward1…5.registrar-servers.com` | Namecheap email forwarding: **don't touch** |

DNS is at Namecheap (nameservers `dns1/dns2.registrar-servers.com`), so all
DNS changes below happen in **Namecheap → Domain List → campusride.app →
Manage → Advanced DNS**.

## Step 1: deploy the new site on its onrender.com address

You can do this before the pull request merges, by deploying the branch.

1. Render dashboard → **New → Static Site**.
2. Connect the repository **Ativor-Godsway/CampusRide-app**.
3. Fill in:
   - **Name:** `campusride-web`
   - **Branch:** `web-site-legal-pages` for now (switch to `main` after the
     PR merges, step 1.7)
   - **Root Directory:** leave empty
   - **Build Command:** `node apps/web/build.mjs`
   - **Publish Directory:** `apps/web/dist`
   - No environment variables.
4. **Create Static Site.** The build takes seconds (it installs nothing).
5. Optional but recommended, **Headers** tab: add these four, each for path
   `/*` (they're also listed in `render.yaml` under `campusride-web`):

   | Name | Value |
   |---|---|
   | `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
   | `X-Content-Type-Options` | `nosniff` |
   | `Referrer-Policy` | `strict-origin-when-cross-origin` |
   | `Strict-Transport-Security` | `max-age=15552000` |

6. Open `https://campusride-web.onrender.com` (Render shows the exact
   address) and check each page: `/`, `/privacy`, `/terms`, `/support`,
   `/delete-account`, `/sitemap.xml`, `/robots.txt`, and a made-up address
   like `/nope` (should show "Page not found"). On a phone too.
7. After the PR merges: **Settings → Build & Deploy → Branch → `main`**.
   From then on every merge to `main` redeploys the site.
   Optional: **Build Filters → Included paths** `apps/web/**` and
   `packages/shared/src/account/**`, so it only rebuilds when the site (or
   the deletion retention period it quotes) changes.

## Step 2: move v1 to v1.campusride.app, then point the domain at the new site

Order matters: v1 gets its new name first (no downtime, nothing else
changes), then the main domain moves in one quick DNS edit.

### 2a. The day before: shorten the DNS cache time

In Namecheap Advanced DNS, set the **TTL** of the `@` A record and the `www`
CNAME record to **1 min**. Save. Wait for the old TTL to pass (Namecheap's
"Automatic" is 30 minutes; waiting a few hours is safe). This makes the
switch in 2c take effect within minutes for everyone.

Also look for a **CAA** record on `@`. If there is one, add two more:
`0 issue "letsencrypt.org"` and `0 issue "pki.goog"`, so Render can issue
certificates. (No CAA record at all is fine.)

### 2b. Give v1 its new address (Vercel)

1. Vercel → the v1 project → **Settings → Domains → Add** →
   `v1.campusride.app` → Add. Choose to connect it to production, with no
   redirect.
2. Vercel shows the DNS record it wants, normally a **CNAME** for `v1`. Copy
   the value exactly as Vercel shows it.
3. Namecheap Advanced DNS → **Add New Record** → **CNAME Record**, Host `v1`,
   Value: what Vercel showed, TTL Automatic → save (the green tick).
4. Back in Vercel, wait until the domain shows **Valid Configuration**
   (usually a few minutes), then open `https://v1.campusride.app`. It should
   show the old site with a valid padlock.

v1 is now reachable at both addresses. Nothing has changed for anyone yet.

### 2c. Point campusride.app and www at the new site (Render)

Pick a quiet time. Expect a few minutes during which the site may show a
certificate warning while Render issues its certificate.

1. Render → `campusride-web` → **Settings → Custom Domains → Add Custom
   Domain** → `campusride.app` → Save. Render adds `www.campusride.app` too
   and redirects it to `campusride.app`. If it doesn't, add `www.campusride.app`
   yourself.
2. Render now shows the DNS records it wants. Normally:
   - for `campusride.app`: an **A record** to `216.24.57.1` (or an ALIAS to
     `campusride-web.onrender.com`);
   - for `www.campusride.app`: a **CNAME** to `campusride-web.onrender.com`.

   Use exactly what Render shows if it differs from this.
3. Namecheap Advanced DNS, in one sitting:
   - **Edit** the A record with Host `@`: change `216.198.79.1` to Render's
     address. (Or delete it and add Render's ALIAS record instead, if Render
     asked for an ALIAS.)
   - **Edit** the CNAME record with Host `www`: change the Vercel value to
     `campusride-web.onrender.com`.
   - If there are **AAAA** records for `@` or `www`, delete them.
   - **Leave alone:** the `api` CNAME, the `v1` CNAME, the MX records, and any
     TXT records (email forwarding, SPF, site verification).
   - Save each row (green tick).
4. Render → Custom Domains → **Verify** on each domain. When both show
   **Certificate issued**, open `https://campusride.app` and
   `https://www.campusride.app` (it should land on `https://campusride.app`).
   If verification fails at first, wait five minutes and press Verify again.
5. Check `https://api.campusride.app/health` still answers. (It should: its
   record wasn't touched.)
6. Vercel → v1 project → Settings → Domains: **remove** `campusride.app` and
   `www.campusride.app` (keep `v1.campusride.app`). Do this only after step 4
   works.
7. Namecheap: set the TTLs back to **Automatic**.

**Rolling back**, if something goes badly wrong in 2c: put the `@` A record
back to `216.198.79.1` and the `www` CNAME back to the Vercel value you
replaced, and v1 is back within a minute or two (the TTL is 1 min). Note the
old values down before you change them.

### 2d. After the move

- Google Play Console → **App content**: Privacy policy URL
  `https://campusride.app/privacy`; **Data safety → Data deletion** URL
  `https://campusride.app/delete-account`. Same for both apps.
- Optional: Google Search Console → add the domain `campusride.app` (it asks
  for a TXT record in Namecheap) → **Sitemaps** → submit `sitemap.xml`.
- The API needs no change: the new site doesn't call it. (v1's demo calls the
  old Oregon server `campusride-server-it9e.onrender.com`, not
  `api.campusride.app`, so v1's new address doesn't need adding to
  `CORS_ALLOWED_ORIGINS` either. Once that old service is retired, v1's demo
  stops working, which is fine for a reference copy.)

## Step 3: keep v1 out of search results

In the v1 repository (not this one), add this line inside `<head>` of its
`index.html`, next to the other `<meta>` tags, then deploy v1 as usual:

```html
<meta name="robots" content="noindex, nofollow" />
```

Optionally, to cover every file Vercel serves (images, PDFs) and not just the
page, also add this `vercel.json` at the root of the v1 repository (or merge
the `headers` entry into an existing one):

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }]
    }
  ]
}
```

Don't also block v1 in a `robots.txt` (`Disallow: /`): a crawler that may
not fetch the pages never sees the noindex, and old results can linger.

Check it worked: open `https://v1.campusride.app`, view the page source and
find `noindex`; or `curl -sI https://v1.campusride.app | grep -i robots` for
the header version. Google drops v1's pages the next time it crawls them,
usually within a few weeks.

## Changing the website later

- Text: edit `apps/web/src/pages/*.html`.
- Operator name, address, support phone, draft banners, **store links**:
  `apps/web/site.config.mjs`. Paste an app's App Store or Google Play address
  into `stores` and its official badge replaces "Coming soon".
- Prices, pickup areas, the welcome animation: nothing to do on the website.
  The build reads them from the code; after a price change, re-run
  `python3 apps/web/tools/screenshots.py` (the tests say so).
- Logo, icons, link preview picture: change the files in `assets/brand/` and
  run `python3 scripts/brand/generate.py`.
- Merge to `main`; Render redeploys. `apps/web/README.md` has the details.

### Headers

The headers in `render.yaml` reach the live site only through the Render
dashboard (**campusride-web → Settings → Headers**, path `/*`). Whenever the
`Content-Security-Policy` in `render.yaml` changes, paste the new value there
too. Since the October 2026 home page it must allow the site's own script,
fonts and animation file (`script-src`, `font-src`, `connect-src`); with the
older value the page still works but shows system fonts and no animation.
