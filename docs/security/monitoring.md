# Monitoring: error reports, alerts and health checks

What tells you something is wrong before a rider does. Pre-launch
hardening, Stage 5 (2026-10-16). Written for the owner and anyone changing
the server or the apps. **Setting it up, step by step:**
[DEPLOY.md → Monitoring](../../DEPLOY.md#monitoring-sentry-uptimerobot-neon).

## The pieces

| Piece | What it watches | Where it tells you |
|---|---|---|
| **Sentry**, in the server, rider app, driver app and admin site | Crashes and errors, plus the alerts below | An email from Sentry the first time each new problem appears; the Sentry dashboard |
| **`/health/ready`** + UptimeRobot | Is the server up, and can it reach the database? | An email from UptimeRobot when it stops answering `200` |
| **Render logs** | Everything, scrubbed (Stage 4) | Render → the server → Logs; every alert line has an `"alert"` field |

Everything is **off until a DSN is set**: with no `SENTRY_DSN` (server),
`VITE_SENTRY_DSN` (admin site) or `EXPO_PUBLIC_SENTRY_DSN` (apps), nothing is
sent anywhere and everything behaves as before. Alerts are then only written
to the logs.

## What reaches Sentry

**From the server** (`apps/server/src/lib/monitoring.ts`):

- Every request that ended in a 500, tagged with the same **request id** the
  user was shown (`requestId`), the route and the method. 4xx answers (bad
  input, not signed in, a route's own refusal) are not reported.
- Crashes: unhandled promise rejections, uncaught exceptions and failed
  startups, at `fatal` level, sent before the process exits.
- The alerts below.

**From the rider and driver apps** (`packages/mobile-shared/src/monitoring`):
JavaScript errors and native crashes (the app killed or frozen), tagged
`app` (rider/driver), and with which build and which over-the-air update
it was: `expo.update_id`, `expo.channel`, `expo.runtime_version`. Sentry
also reads the app version and build number itself.

**From the admin site** (`apps/admin/src/monitoring.ts`): errors in the page,
tagged with the commit Render built.

**Releases.** The server reports the deployed commit (`RENDER_GIT_COMMIT`),
the admin site the commit it was built from, the apps their version and
build number plus the update id. So every report says which version it
came from.

**Performance.** 2 in every 100 requests (server), page loads (admin site)
and app starts (apps) are traced, to stay inside Sentry's free plan. Change
with `SENTRY_TRACES_SAMPLE_RATE`, `VITE_SENTRY_TRACES_SAMPLE_RATE` or
`EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (a number from 0 to 1).

## Alerts

Reported to Sentry at error level (warning for the SMS balance), and logged
with an `"alert"` field. Each has a stable `alert` tag in Sentry
(`apps/server/src/lib/alerts.ts`).

| `alert` | When | Why it matters |
|---|---|---|
| `sms_failed` | **Every** SMS Moolre refuses or that can't reach Moolre (login codes and ride texts). Never includes the number or the text. | Someone couldn't sign in |
| `push_failures` | 10 pushes refused or undelivered within 15 minutes (an uninstalled app doesn't count). Then at most once an hour. | Drivers miss ride requests; riders miss "driver arrived" |
| `database_connection` | 3 "can't reach the database" / "connection lost" / "no free connection" errors within 5 minutes, from requests, the ride sweep, `/health/ready` or socket sign-in. Then at most once every 30 minutes. | The whole app is down or about to be |
| `timeout_sweep_failures` | The 30-second ride timeout sweep fails 3 times within 5 minutes. Then at most once an hour. | Unanswered rides could stay stuck |
| `socket_auth_failures` | 30 socket connections refused within 10 minutes for a **missing, forged or malformed** token. An expired token isn't counted: the apps refresh and reconnect, notably after every deploy. Then at most once an hour. | Someone probing, or a broken app release |
| `moolre_balance_low` | The Moolre SMS balance is below `MOOLRE_SMS_LOW_BALANCE` (default 100). Checked a minute after startup and every 6 hours; warns at most once a day. | When it runs out, nobody can sign in |
| `moolre_balance_unreadable` | The balance couldn't be read; reported once per server start. | Check the balance by hand |

**The Moolre balance check** uses the call Moolre's own WordPress plugin
uses (`POST /open/sms/query`, `{"type": 2}`, answered with `data.balance`).
It isn't in Moolre's public documentation, so if Moolre changes it you get
`moolre_balance_unreadable` and need to check the balance by hand (DEPLOY.md).
It only runs when login codes really go through Moolre.

## What never reaches Sentry

Every event passes through one scrubber, shared by the server, both apps and
the admin site (`packages/shared/src/redact/sentryEvent.ts`), with the same
rules as the logs ([validation-and-errors.md](validation-and-errors.md#what-never-appears-in-a-log)):

- phone numbers masked (`+233*****146`) in messages, errors, breadcrumbs,
  URLs, tags, extras and trace data;
- tokens, codes and secret-named fields removed;
- request bodies, cookies and all but a few harmless headers dropped
  (no `Authorization`);
- no user details but an id; no IP address (`sendDefaultPii: false`);
- in the apps, no screenshots and no screen layout; no session replay
  anywhere.

This was checked end to end: the built server sent its reports to a fake
Sentry on this Mac, with a phone number and a token in the request; neither
appeared in anything sent.

## Health checks

| | `GET /health` | `GET /health/ready` |
|---|---|---|
| Checks | The process is running | The process is running **and** the database answers `SELECT 1` within 3 s |
| Answers | Always `200 {status, app}` | `200 {status, app, database: "ok"}`, or `503` with `database: "unreachable"` or `"timeout"` |
| Used by | Render's health check (stays on `/health`: a database outage must not make Render restart a healthy server over and over) | UptimeRobot |

Both are public, unlimited and say nothing about why something is down.

## The apps: builds, updates and source maps

- Sentry in the apps includes native code, so it is only in builds made
  after this change; over-the-air updates published from then on reach only
  those builds (the apps use fingerprint versioning).
- `EXPO_PUBLIC_SENTRY_DSN` is read when a build or update is **made**, from
  the EAS environment variables of each app (environment `production`, which
  every build profile and `scripts/eas-update.sh` use).
- **Source maps** turn the app's compiled code back into real file names and
  lines in Sentry. `scripts/eas-update.sh` uploads them after an update when
  `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` are set in your terminal; otherwise it
  skips them. Builds don't upload them (Sentry's build plugin fails every
  build that has no Sentry token, so it isn't used): an error in the code a
  build shipped with, before any update, shows compiled line numbers.
  Native crash reports from iOS also lack symbols for the same reason.
- `metro.config.js` uses `getSentryExpoConfig`, Expo's default config plus a
  debug id in each bundle, which is what matches uploaded source maps to the
  code.

## Settings

| Setting | Where | Default |
|---|---|---|
| `SENTRY_DSN` | Render → campusride-server | unset (off) |
| `SENTRY_TRACES_SAMPLE_RATE` | Render → campusride-server | `0.02` |
| `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | Render → campusride-server | `NODE_ENV`, `RENDER_GIT_COMMIT` |
| `MOOLRE_SMS_LOW_BALANCE` | Render → campusride-server | `100` |
| `VITE_SENTRY_DSN` | Render → campusride-admin (needs a redeploy) | unset (off) |
| `EXPO_PUBLIC_SENTRY_DSN` | expo.dev → each app → Environment variables (needs a build or update) | unset (off) |

A production server without `SENTRY_DSN` starts normally and logs a warning
saying errors are only logged.
