# Admin protection and secrets

Who can use the admin site, how long they stay signed in, how you'd notice a
stranger, which settings the server refuses to start without, and every
secret to rotate before launch. Written for the owner. Stage 3 of the
pre-launch hardening, 2026-10-15.

## Who can use the admin site

Two keys, both needed:

1. The account's role is `ADMIN` in the database (set by hand with
   `src/scripts/seedAdmin.ts`), **and**
2. its phone number is on **`ADMIN_PHONE_ALLOWLIST`**, a setting that lives
   only on Render.

A database row that says `ADMIN`, through a mistaken edit or a database
leak, gets nowhere without the number also being on the list. An `ADMIN`
account off the list can't log in at all, and its open session ends the
next time it renews.

**Set it:** Render → the server → Environment → `ADMIN_PHONE_ALLOWLIST` =
your number, in any spelling (`0241234567` or `+233241234567`). Use commas for
more than one. In production the server won't start without at least one
valid number, so a typo shows up as a failed deploy rather than a silently
open or locked admin site. To remove someone: delete their number and save
(Render restarts the server); their session ends within seconds.

Outside production an empty list lets any `ADMIN` account in, so local work
needs no setup.

## Admin sessions are short

| | Value | Setting |
|---|---|---|
| Access token (what each request carries) | 10 minutes, renewed automatically while you use the site | `ADMIN_ACCESS_TOKEN_MINUTES` |
| Signed out after no activity | 30 minutes | `ADMIN_IDLE_MINUTES` |
| Hard maximum, however active you are | 8 hours from signing in | `ADMIN_SESSION_MAX_HOURS` |

There is no long-lived token. The renewal token dies after 30 unused minutes
and never outlives the 8 hours. It is single-use, and both tokens live only
in that browser tab (closing the tab ends the session). The page also signs
itself out after 30 minutes without a click or key press, so a screen of
phone numbers isn't left on an unattended computer. A stolen admin token is
useless within minutes. Rider and driver sessions are unchanged.

Why these numbers: 8 hours is a working day, so you sign in (one SMS code) at
most once a day while working; 30 idle minutes covers a lunch break left
open; 10 minutes keeps a leaked token short-lived without you noticing the
renewals.

## Noticing a stranger: "Admin logins"

Every attempt to sign in to the admin site is recorded with its time, IP
address and device: codes sent, wrong codes, refusals and successes. Attempts
on an admin's number made through the rider app are recorded too. The admin
site's **Admin logins** tab lists them, newest first.

What to look for: a "Signed in" you didn't do, a sign-in from an unfamiliar
device or place, or codes sent to your number that you didn't ask for. That
pattern, especially right after your phone lost signal, is what a stolen SIM
looks like. If you see it, remove your number from `ADMIN_PHONE_ALLOWLIST`
straight away, then call your carrier.

## The admin site's security headers

Before Stage 3, the admin site sent `X-Frame-Options: DENY` and
`X-Robots-Tag: noindex, nofollow`, and its page carried a robots `noindex` tag.
Nothing else.

Now (in `render.yaml`):

| Header | What it does |
|---|---|
| `Content-Security-Policy` | Only the site's own script runs; it may talk only to `https://api.campusride.app` and Sentry's error intake (Stage 5); images only from itself, Cloudinary (driver photos) and OpenStreetMap's map tiles; `frame-ancestors 'none'` (no framing). |
| `X-Frame-Options: DENY` | No framing, for older browsers. |
| `X-Robots-Tag: noindex, nofollow` (+ `robots.txt`) | Never in search results. |
| `Strict-Transport-Security` | HTTPS only, for 180 days. |
| `X-Content-Type-Options: nosniff` | No guessing file types. |
| `Referrer-Policy: no-referrer` | Admin URLs never leak to other sites. |
| `Permissions-Policy` | No camera, microphone, location or payments. |
| `Cross-Origin-Opener-Policy: same-origin` | Other windows can't reach into it. |

The policy was tested against the real built site in Chrome: every screen,
including the map and driver photos, loads with no violations.

**If you change `VITE_API_URL`,** change `connect-src` in the same header, or
every request from the admin site is blocked.

**Check it after deploying:** these headers apply only if Render manages the
admin site from `render.yaml`. In the Render dashboard, open `campusride-admin`
→ Settings → Headers and confirm they are there; if the site was created by
hand, add them there.

## Proposal, not built: a second factor for admins

Today an admin signs in with an SMS code. Someone who takes over your number
(a SIM swap at a carrier shop) receives that code. The allowlist doesn't help
then: it's your number.

**Proposal: an authenticator-app code (TOTP) on top of the SMS code.**

- **Setting up:** after your next sign-in, the admin site shows a QR code once.
  You scan it with Google Authenticator, Microsoft Authenticator or Authy. The
  server keeps the shared secret encrypted with a new Render setting
  (`ADMIN_TOTP_KEY`), never readable from the database alone.
- **Signing in:** SMS code, then the 6-digit code from the app. A stolen SIM
  gets the first but not the second, which lives on your phone, not your
  number.
- **Recovery:** 10 one-time recovery codes shown once at setup (keep them on
  paper); used codes stop working. If you lose both phone and codes, the way
  back is a script you run by hand against the database, as with `seedAdmin`.
- **Enforced** for every admin, recorded in the sign-in log like everything
  else.
- **Cost:** about a day of work, no new services or fees, works offline.

**Better still, later: passkeys** (Face ID, a fingerprint or a security key
via WebAuthn). They can't be phished at all, but take more work and need
care with recovery. Worth doing once there is more than one admin.

**Not built yet.** Decided 2026-10-16: **passkeys** rather than an
authenticator-app code, built later, before public launch.

## Secrets in the git history (the repo is public)

- **Scanner:** gitleaks 8.30.1 (installed with Homebrew) over all **205
  commits on all 40 branches**, values redacted. **0 findings.**
- **Pattern search** for this project's own formats (Neon `npg_` passwords,
  database URLs with passwords, `JWT_SECRET`, Moolre and Cloudinary keys,
  Firebase `AIza…` keys, private keys, Expo tokens) over every added line.
  Six hits, every one a placeholder in an example file or a test (`password`,
  `replace-with-…`, `shh-secret`).
- **Files ever committed:** no `.env`, `google-services.json`, key or
  credentials file, ever. The committed `scripts/eas-google-services.mjs` is
  a script, not the file.
- **`apps/server/.env.backup-prod-2026-09-25`:** gone from this Mac and never
  committed. Nothing to delete.
- **Found instead:** `apps/server/.env` on this Mac (git-ignored, never
  committed) holds the **current production** database URLs, password
  included. Prisma commands read that file by themselves, so a stray command
  there would act on production. It belongs in the rotation list below. The
  file should go back to development values only (see
  `docs/environments.md`).

## What the server refuses to start without (production)

Checked before the server opens its port. Only setting names are ever
logged, never values. A missing setting means the new deploy never becomes
healthy, and Render keeps the previous version running (normal on paid
plans; I couldn't confirm the free plan does the same, so set these before
merging).

| Setting | Rule |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Set; a `postgres://` URL; not localhost |
| `JWT_SECRET` | At least 32 random bytes (`openssl rand -hex 32`); not a placeholder or a repeated character |
| `PUBLIC_BASE_URL` | An `https://` address (SOS links are built from it) |
| `CORS_ALLOWED_ORIGINS` | At least one `https://` origin (the admin site) |
| `ADMIN_PHONE_ALLOWLIST` | At least one admin number; no entries that aren't Ghanaian numbers |
| `SUPPORT_CONTACT_PHONE` | A Ghanaian number (every SOS also reaches it) |
| Login codes | `OTP_PROVIDER=moolre` + `MOOLRE_SMS_ENABLED=true` + `MOOLRE_VAS_KEY` + `MOOLRE_SMS_SENDER_ID` (or `OTP_PROVIDER=mnotify` + `MNOTIFY_ENABLED=true` + `MNOTIFY_API_KEY`) |
| With `MOOLRE_PAYMENTS_ENABLED=true` | `MOOLRE_API_USER`, `MOOLRE_PUBLIC_KEY`, `MOOLRE_PRIVATE_KEY`, `MOOLRE_ACCOUNT_NUMBER`, and `MOOLRE_WEBHOOK_SECRET` of 16+ characters |
| Must NOT be on | `ENABLE_MOCK_DRIVER=true`; `ENABLE_USSD=true` (its callback has no authentication yet); `TRUST_PROXY=true` |
| On Render | `NODE_ENV=production` (every production safeguard depends on it) |

Warnings only: Cloudinary not configured (driver photo uploads answer 503),
`TRUST_PROXY` set at all, payments pointed at Moolre's sandbox.

## Secrets to rotate before launch

Rotate everything that has been typed, pasted or kept on a laptop during
development. After each change on Render, the server restarts by itself.

| Secret | Where it is set | How to rotate | What happens |
|---|---|---|---|
| **Neon production database password** (inside `DATABASE_URL` and `DIRECT_URL`) | Render (server); also in `apps/server/.env` on this Mac | Neon console → production project → Roles → `neondb_owner` → Reset password. Paste the new password into both URLs on Render. Remove it from `apps/server/.env`. | A few seconds of restart. |
| **`JWT_SECRET`** | Render | `openssl rand -hex 32` on your Mac → paste into Render | Everyone is signed out and logs in again. Best done before launch. |
| **`MOOLRE_VAS_KEY`** (SMS) | Render | Moolre dashboard → API keys → regenerate the VAS key → Render | Login codes pause for the seconds between the two steps. |
| `MOOLRE_PRIVATE_KEY`, `MOOLRE_PUBLIC_KEY`, `MOOLRE_API_USER` (payments; off today) | Render, if set | Moolre dashboard → regenerate → Render | None while payments are off. |
| `MOOLRE_WEBHOOK_SECRET` (payments) | Render and Moolre's webhook settings | Choose a new 32+ character value, set it in both places | None while payments are off. |
| `MNOTIFY_API_KEY` | Render, if set | mNotify dashboard → API → regenerate | Only matters if mNotify is used. |
| **`CLOUDINARY_API_SECRET`** (+ `CLOUDINARY_API_KEY`) | Render | Cloudinary console → Settings → API Keys → generate a new pair → Render → delete the old pair | Driver photo uploads pause for those seconds. |
| `EXPO_ACCESS_TOKEN` | Render, if set | expo.dev → Account settings → Access tokens → create a new one, revoke the old | Push sends pause for those seconds. |
| **Firebase service-account key** (FCM, for Android push) | Uploaded to EAS with `eas credentials` | Google Cloud console → IAM → Service accounts → Keys → add a new key → `npx -y eas-cli@24 credentials` → upload → delete the old key in Google Cloud | None if done in that order. |
| Firebase Android API key (inside `google-services.json`, EAS file variable `GOOGLE_SERVICES_JSON`) | EAS (and the gitignored local copy) | Not a true secret (it ships inside the app). **Restrict it** instead: Google Cloud console → APIs & Services → Credentials → the key → Android apps → add `com.campusride.rider` / `com.campusride.driver` with their signing SHA-1s | Rotating it would need new store builds; restricting doesn't. |
| Mapbox token (`EXPO_PUBLIC_MAPBOX_TOKEN`) | The apps' `.env` / EAS | Public by design (it ships inside the app). Restrict it in the Mapbox account to the apps' bundle ids | None. |
| Old US Neon project password (the one in the deleted backup file) | The old project | Delete the old US Neon project once retired, or reset its password now | None. |
| Your Expo, Render, Neon, Cloudinary, Moolre, GitHub and UptimeRobot logins | Each service | Strong unique passwords and two-factor sign-in on every one; these accounts can change everything above | None. |

The admin site and `VITE_API_URL` hold no secrets. Nothing secret is
committed to the repository.
