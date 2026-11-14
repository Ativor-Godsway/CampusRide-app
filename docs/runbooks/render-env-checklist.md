# Render settings for the production server: a checklist

Every setting `campusride-server` reads, in one list, so you can tick them
off in **Render → `campusride-server` → Environment**. Made for the final
pre-launch audit (2026-11-10) from `apps/server/src/config.ts`,
`apps/server/src/lib/productionEnv.ts` and the other files that read them.

- **Required:** the server refuses to start without it (or with it wrong).
  Render then keeps the previous version running and the deploy fails with
  `Refusing to start: …` in the log, naming the setting (never its value).
- **Recommended:** the server starts without it, but something doesn't work
  (the log has a `production_env_warning` line for most of these).
- **Leave unset:** the built-in default is right; setting it is a mistake.

Values in `code` are the ones to have. "Secret" means: never paste it
anywhere except Render, and never in a chat, a screenshot or a file in this
repository.

## Required

| ✓ | Setting | What it does | Value |
|---|---|---|---|
| ☐ | `NODE_ENV` | Turns on every production safeguard. On Render the server won't start without it. | `production` |
| ☐ | `DATABASE_URL` | Neon **pooled** connection to the production branch. | Secret. Its host must contain `ep-empty-violet-bay5yr3y-pooler`, and it must end with `pgbouncer=true&connection_limit=5` ([DEPLOY.md](../../DEPLOY.md#database_url-format)) |
| ☐ | `DIRECT_URL` | Neon **direct** connection (migrations). | Secret. The same host without `-pooler` |
| ☐ | `JWT_SECRET` | Signs every login. Refused if shorter than 32 random bytes or a placeholder. | Secret. `openssl rand -hex 32` (changing it signs everyone out) |
| ☐ | `PUBLIC_BASE_URL` | The address SOS tracking links are texted with. Must be https. | `https://api.campusride.app` |
| ☐ | `CORS_ALLOWED_ORIGINS` | The browser sites allowed to call the API: the admin site. https only, no trailing `/`. | `https://campusride-admin.onrender.com` |
| ☐ | `ADMIN_PHONE_ALLOWLIST` | The only numbers that may use the admin site. Refused if empty or if any entry isn't a Ghana number. | Your own admin number(s), comma-separated |
| ☐ | `SUPPORT_CONTACT_PHONE` | Every SOS is also texted here, so an SOS from a rider with no emergency contact still reaches a person. | A Ghana number someone answers at all hours |
| ☐ | `OTP_PROVIDER` | Who sends login codes. | `moolre` |
| ☐ | `MOOLRE_SMS_ENABLED` | Moolre SMS on (login codes, SOS texts). | `true` |
| ☐ | `MOOLRE_VAS_KEY` | Moolre SMS key. | Secret |
| ☐ | `MOOLRE_SMS_SENDER_ID` | The sender name texts come from, approved by Moolre. | Your approved sender ID |

Also needed for SMS, though the boot check doesn't name them:

| ✓ | Setting | What it does | Value |
|---|---|---|---|
| ☐ | `MOOLRE_BASE_URL` | Moolre's address. **Unset means Moolre's sandbox**, where no real texts go out. | `https://api.moolre.com` |
| ☐ | `MOOLRE_API_USER` | The Moolre account user the SMS calls run as. | Your Moolre API user |

## Recommended

| ✓ | Setting | What it does | Value |
|---|---|---|---|
| ☐ | `PAYSTACK_SECRET_KEY` | Drivers paying their commission in the app (and checking Paystack's webhook). Unset: "Pay now" is unavailable. A test key (`sk_test_…`) is refused: the server won't start with one. | Secret. Must start with `sk_live_` |
| ☐ | `PAYSTACK_FEE_PERCENT` | The payment fee rate used until an admin sets one in Settings → Driver commission. Unset means 0. | `1.95` (Paystack Ghana's local rate; check your Paystack pricing page) |
| ☐ | `PAYSTACK_FEE_CAP_GHS` | Optional cap on the fee, in cedis, until an admin sets one. | Unset, unless your Paystack plan has a cap |
| ☐ | `SENTRY_DSN` | Server errors and alerts reach Sentry. Unset: only logged. | The `campusride-server` DSN (not a password, but keep it private) |
| ☐ | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Driver photo uploads. Unset: photo uploads answer 503. | `CLOUDINARY_API_SECRET` is secret |
| ☐ | `DRIVER_OFFER_SECONDS` | How long a ride offer stays on a driver's screen. The apps read it from each offer: no app release needed to change it. Unset means 15. | `20` |
| ☐ | `SUPPORT_PHONE` | The number "Call support" dials in both apps (`GET /app/config`). Unset or invalid means the built-in +233548608146. | `+233548608146` (production answers this today) |
| ☐ | `STORE_URL_RIDER_IOS` | The App Store link on the rider app's "Time to update" screen. Unset means the built-in one, which is the same. | `https://apps.apple.com/app/id6827157564` |
| ☐ | `STORE_URL_DRIVER_IOS` | The same for the driver app. | `https://apps.apple.com/app/id6827179216` |
| ☐ | `MOOLRE_PAYMENTS_ENABLED` | Moolre ride payments. Off: rides are cash, and commission goes through Paystack. | `false` |
| ☐ | `ENABLE_MOCK_DRIVER` | Development-only fake driver. `true` is refused in production. | `false` |
| ☐ | `ENABLE_USSD` | The USSD channel. `true` is refused (its callback has no authentication yet). | `false` |

## The review demo (App Store and Google Play reviewers)

| ✓ | Setting | What it does | Value |
|---|---|---|---|
| ☐ | `REVIEW_DEMO_ENABLED` | The demo's kill switch. The boot log warns while it's on. | `true` until Google Play's production review is approved, then `false` |
| ☐ | `REVIEW_DEMO_RIDER_PHONE` | The rider number reviewers sign in with (fixed code, no SMS). | `0240000001` |
| ☐ | `REVIEW_DEMO_DRIVER_PHONE` | The driver number reviewers sign in with. | `0240000002` |
| ☐ | `REVIEW_DEMO_OTP` | The fixed 6-digit code, given to reviewers in the store review notes only. | Secret-ish: exactly 6 digits, and not something guessable like `123456` |

The demo stays off by itself (and says why in the admin dashboard) if a
number is invalid, if the two are the same, if the code isn't 6 digits, or if
a demo number is on `ADMIN_PHONE_ALLOWLIST`.

## Optional: leave unset unless you have a reason

| Setting | Default | Notes |
|---|---|---|
| `MIN_VERSION_RIDER_IOS`, `MIN_VERSION_DRIVER_IOS`, `MIN_VERSION_RIDER_ANDROID`, `MIN_VERSION_DRIVER_ANDROID` | unset: nobody is forced to update | Set to e.g. `1.0.1` only when an old build must stop working ([releasing.md](releasing.md#forcing-people-off-an-old-build-time-to-update)) |
| `STORE_URL_RIDER_ANDROID`, `STORE_URL_DRIVER_ANDROID` | the Play listings for `com.campusride.rider` / `.driver` | Correct once the apps are on Google Play |
| `EXPO_ACCESS_TOKEN` | unset | Secret. Only if "Enhanced Security for Push Notifications" is on in Expo |
| `PUSH_DISABLED` | unset (push on) | `true` switches every push notification off: an emergency switch |
| `SENTRY_ENVIRONMENT` | `production` (from `NODE_ENV`) | |
| `SENTRY_TRACES_SAMPLE_RATE` | 2 in 100 | Higher uses up the free Sentry plan |
| `SENTRY_RELEASE` | the deployed commit | Render provides `RENDER_GIT_COMMIT` |
| `MOOLRE_SMS_LOW_BALANCE` | `100` | Below this the server warns in Sentry |
| `MOOLRE_PUBLIC_KEY`, `MOOLRE_PRIVATE_KEY`, `MOOLRE_ACCOUNT_NUMBER`, `MOOLRE_WEBHOOK_SECRET` | unset | Secret. Only needed if `MOOLRE_PAYMENTS_ENABLED=true` (then all four are required) |
| `PAYSTACK_BASE_URL` | `https://api.paystack.co` | |
| `ADMIN_PASSKEY_RP_ID`, `ADMIN_PASSKEY_ORIGINS` | `campusride-admin.onrender.com` | Change only if the admin site moves address (passkeys must then be added again) |
| `ADMIN_OTP_FALLBACK` | off | `on` lets an admin with a passkey also sign in with a texted code: recovery only |
| `ADMIN_ACCESS_TOKEN_MINUTES`, `ADMIN_IDLE_MINUTES`, `ADMIN_SESSION_MAX_HOURS` | 10, 60, 12 | Admin session lengths |
| `DRIVER_SILENCE_TIMEOUT_MIN` | `30` | A driver whose app went silent while in front is taken offline after this |
| `RIDE_AUTO_COMPLETE_HOURS` | `3` | A ride still in progress after this is completed |
| `TRACKING_LINK_TTL_HOURS` | `24` | How long an SOS link works after the ride |
| `ACCOUNT_DELETION_RETENTION_DAYS` | `90` | Matches the Privacy Policy; don't change without updating it |
| `RATE_LIMIT_*` (about 35 of them) | see [rate-limits.md](../security/rate-limits.md) | The defaults are the tested numbers |
| `MNOTIFY_ENABLED`, `MNOTIFY_API_KEY`, `MNOTIFY_SENDER_ID` | unset | The other SMS provider; not used |
| `LOG_LEVEL` | `info` | |
| `PORT`, `RENDER`, `RENDER_GIT_COMMIT` | set by Render | Never set these yourself |

## Must NOT be set in production

| Setting | Why |
|---|---|
| `TRUST_PROXY` | `true` is refused (anyone could choose their own IP). Any other value gets a warning: delete it. |
| `LOAD_TEST_OTP_CODE` | Refused: it makes every login code the same. Local load test only. |
| `ALLOW_NON_PRODUCTION_ON_RENDER` | Lets the server run on Render without its production safeguards. |
| `ALLOW_PRODUCTION_DB`, `ALLOW_TEST_DB_HOST` | For one-off scripts on your Mac. Never on the server. |
| `RATE_LIMIT_MULTIPLIER` | Ignored in production anyway. |
| `DEMO_OTP_CORS_ORIGINS` | The old name for `CORS_ALLOWED_ORIGINS`. Delete it once `CORS_ALLOWED_ORIGINS` is set. |
| `MOOLRE_ENABLED` | The old single switch. Leave it out, so the two specific switches above decide. |

## What the audit could confirm from outside (2026-11-10)

Production is up and running the latest `main`, so the boot check has
passed. That proves every **Required** setting is present and well-formed:
the database URLs, a strong `JWT_SECRET`, https `PUBLIC_BASE_URL` and CORS,
the admin allowlist, `SUPPORT_CONTACT_PHONE` and real SMS settings.
`GET /app/config` answers `+233548608146`, and `GET /app/min-version`
carries both App Store links. What can only be checked in the dashboard:
`PAYSTACK_SECRET_KEY` starting `sk_live_`, `PAYSTACK_FEE_PERCENT`,
`DRIVER_OFFER_SECONDS=20`, `MOOLRE_BASE_URL`, `SENTRY_DSN`, and the review
demo settings.
