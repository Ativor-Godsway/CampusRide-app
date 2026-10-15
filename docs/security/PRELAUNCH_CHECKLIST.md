# Pre-launch security & reliability checklist

Every item of the six-stage hardening pass, and what only the owner can do.
Updated at the end of each stage.

✅ done · 🔶 done on a branch, waiting for merge · ⬜ not done

## Stage 1 — Permissions ✅ (PR #36)

| | Item |
|---|---|
| ✅ | Inventory of every HTTP route and Socket.io event: [route-inventory.md](route-inventory.md), checked against the code by a test |
| ✅ | Ownership enforced on every route; someone else's ride, seat or rating answers 404, same as one that doesn't exist |
| ✅ | OTP verification tokens can no longer be used as a login (they could watch other people's shared rides live) |
| ✅ | Roles come from the database, not the token; deleted accounts are refused even with an unexpired token |
| ✅ | Socket.io: token checked at the handshake; ride rooms only for the driver and riders still in the car; driver positions only from the ride's own driver; every payload validated |
| ✅ | Mass assignment: every write takes only allow-listed fields (role, approval, online status, fares, other people's ids can't be set), proven by tests |
| ✅ | A rider cancelling a shared car takes only themselves out; others keep their ride |
| ✅ | Ratings only between people who actually took the trip |
| ✅ | SOS links are per rider, show only that rider, and expire 24 h after the ride ends (`TRACKING_LINK_TTL_HOURS`) |
| ✅ | Contact numbers stop with the trip: no driver number on a cancelled ride; no rider number once they've left the car |
| ✅ | Table-driven cross-user tests for every route and socket event (rider vs rider, driver vs driver, rider vs admin) |

## Stage 2 — Per-person rate limiting 🔶 (branch `security-stage2-rate-limits`)

| | Item |
|---|---|
| 🔶 | Report of the limits before this stage (key, numbers, store): [rate-limits.md](rate-limits.md#before-stage-2-2026-10-15) — they were effectively one bucket for the whole app |
| 🔶 | Limits keyed to the person (phone before login, account after, link for `/track`); IP only as a generous backstop on routes nobody is signed in to |
| 🔶 | Real client IP behind Render (trust private + Cloudflare ranges, not a hop count), proven by a test; the IP backstop switches itself off rather than ever pooling people |
| 🔶 | Limits on every costly route (codes, refresh, booking, cancel, accept/decline, ratings, profile, push tokens, uploads, deletion, payments, tracking pages, sockets); SOS never refused, only repeat texts held back; driver GPS throttled, never disconnected |
| 🔶 | Every 429 has `Retry-After` and `retryAfterSeconds`; rider, driver and admin apps say "Try again in X"; code screens count down 60 s to "Resend code" |
| 🔶 | One store interface (in memory now, Redis-ready), documented |
| 🔶 | Admin "Rate limits" screen: look up a number, clear it; both audit-logged |
| 🔶 | 10x looser in development and tests; production can't be loosened |
| 🔶 | Tests: A using up any limit never affects B, even on the same IP; SOS guarantee; `Retry-After` |

## Stage 3 — Admin protection and secrets ⬜

| | Item |
|---|---|
| ⬜ | `ADMIN_PHONE_ALLOWLIST` enforced on admin login and routes |
| ⬜ | Short admin sessions with a hard maximum |
| ⬜ | Every admin login logged; "Recent admin logins" view |
| ⬜ | Second-factor proposal for admins (build only after your OK) |
| ⬜ | Admin site security headers |
| ⬜ | Full git-history secret scan; old prod `.env` backup removed; boot refuses weak/missing production secrets; rotation list |

## Stage 4 — Input validation and error handling ⬜

| | Item |
|---|---|
| ⬜ | JSON schema on every route (no extra fields, length limits, phone/id formats); body and socket payload size limits |
| ⬜ | No stack traces, Prisma or SQL errors to clients in production; request id instead |
| ⬜ | No OTPs, tokens or full phone numbers in logs |
| ⬜ | Unhandled rejections/exceptions logged, then a clean exit |
| ⬜ | Graceful shutdown on deploy |

## Stage 5 — Monitoring ⬜

| | Item |
|---|---|
| ⬜ | Sentry in server, rider, driver and admin (silent without a DSN, scrubbed, low sampling, releases tagged) |
| ⬜ | `/health/ready` with a database check |
| ⬜ | Alerts for failed SMS, failed pushes, DB connection failures, socket auth failures; Moolre balance check |
| ⬜ | DEPLOY.md: Sentry setup, UptimeRobot switch, Neon compute-hour check |

## Stage 6 — Backups, recovery and load ⬜

| | Item |
|---|---|
| ⬜ | Backup and restore runbook (weekly Neon branch, limits, optional `pg_dump`) |
| ⬜ | Incident runbook |
| ⬜ | In-memory state document; startup sweep so no ride is stuck after a restart |
| ⬜ | Connection-pool and Render-plan recommendation |
| ⬜ | Local load test with results in plain English |

## Things only you can do by hand

**Now (Stage 2)**

1. **Before or right after merging:** on Render → the server → Environment,
   **delete `TRUST_PROXY`** if it is there (`render.yaml` used to set it to
   `1`). Also delete any old `RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_OTP_REQUEST`,
   `RATE_LIMIT_OTP_VERIFY`, `RATE_LIMIT_LOGIN`, `RATE_LIMIT_SIGNUP`,
   `RATE_LIMIT_REFRESH`, `RATE_LIMIT_RIDE_CREATE`, `RATE_LIMIT_USSD_CALLBACK`,
   `RATE_LIMIT_UPLOAD_SIGNATURE`, `RATE_LIMIT_SOS`, `RATE_LIMIT_RIDE_CANCEL` (no longer read).
2. **After the deploy:** in Render's Logs, find `client_ip_check` and check it
   says `"resolvedToClient":true` ([rate-limits.md](rate-limits.md#the-real-client-ip-behind-render)).
3. **After merging,** publish an over-the-air update for both apps (the
   resend countdown and "Try again in X" messages):
   `bash scripts/eas-update.sh rider production "…"`, then `driver`.
   The admin site redeploys by itself.

**Stage 1 (PR #36, merged):** migration `20261015180000_tracking_links` must
be applied to production, or SOS fails; if it wasn't done before the merge,
do it now. If no OTA update went out after Stage 1, step 3 covers both stages.

**Later stages** (details come with each stage)

- [ ] Create the Sentry projects and set each DSN (Render, EAS, admin site) — Stage 5
- [ ] Switch the UptimeRobot monitor to `/health/ready` — Stage 5
- [ ] Set `ADMIN_PHONE_ALLOWLIST` on Render — Stage 3
- [ ] Rotate the secrets on the Stage 3 list — Stage 3
- [ ] Make a weekly Neon backup branch (`backup-YYYY-MM-DD`) — Stage 6
- [ ] Choose the Render plan (free vs paid) — Stage 6
