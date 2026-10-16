# When something goes wrong

What to check and what to do, by symptom. Written for the owner. Pre-launch
hardening, Stage 6 (2026-10-16). Keep calm: most problems below are fixed in
minutes, and none of them loses data unless a step says so.

**Where to look first, every time**

| | Where | What it tells you |
|---|---|---|
| UptimeRobot | email, or uptimerobot.com | Is the server up, and can it reach the database (`/health/ready`)? |
| Sentry | email, or sentry.io | The errors and alerts, newest first; each alert has an `alert` tag |
| Render | dashboard → `campusride-server` → **Events** and **Logs** | Deploys, restarts, crashes; every log line |
| Neon | console.neon.tech → the project | Is the database running, suspended, out of compute hours? |
| Status pages | [status.render.com](https://status.render.com), [neonstatus.com](https://neonstatus.com), [status.expo.dev](https://status.expo.dev), [status.sentry.io](https://status.sentry.io) | Is it them, not us? |

When you find the cause, note it (date, what happened, what fixed it) at
the bottom of this file or in a `docs/incident-YYYY-MM-DD-….md`, as with
[the September incident](../incident-2026-09-24-test-rows-in-production.md).

---

## The server is down

*UptimeRobot says Down; the apps say they can't connect; `/health` doesn't answer.*

1. **Render → `campusride-server` → Events.** What happened last?
   - **A deploy failed:** the previous version is still live, so the server
     should be up. Look at the deploy's log for the error and fix it in a new
     change.
   - **A deploy succeeded just before it went down:** the new version is
     bad. Go to [A bad deploy](#a-bad-deploy).
   - **"Out of memory" or repeated restarts:** see Logs for `"event":"fatal"`
     lines and Sentry for the error. Restart (below) buys time; the error
     needs fixing.
2. **Render → Logs**, the last lines before it stopped:
   - `Refusing to start: …` says exactly which setting is missing or wrong
     (only names are printed, never values). Fix it under Environment;
     Render redeploys.
   - `Failed to start server` with a database error: see
     [The database is unreachable](#the-database-is-paused-or-unreachable).
3. **Nothing obvious?** Check [status.render.com](https://status.render.com).
   Then try **Manual Deploy → Restart service**.
4. **On the free plan:** a server with no visitors for 15 minutes is put to
   sleep, and the first request then waits up to a minute. If UptimeRobot
   was paused, that's all it is.

## The database is paused or unreachable

*UptimeRobot says Down on `/health/ready` while `/health` works; Sentry alert
`database_connection`; requests fail with "Something went wrong on our side".*

1. **Neon console → the project → the `main` branch → its compute.**
   - **Suspended/Idle** is normal after 5 quiet minutes; it wakes on the
     next query in a second or two. If it doesn't wake, see the next point.
   - **Out of compute hours** (the free plan's monthly allowance is used up:
     Billing/Usage shows 100%): the database stays off until next month or
     until the plan is upgraded. **Upgrading is the only quick fix.** See
     DEPLOY.md, "Neon: check compute hours every week".
2. **[neonstatus.com](https://neonstatus.com):** if Neon has an incident,
   wait for it; nothing to do on our side.
3. **Errors mention "Timed out fetching a new connection" (P2024):** the
   database is up but the server ran out of connections: a traffic spike, or
   slow queries. A restart clears it. If it keeps happening, the connection
   limit needs raising (docs/runbooks/load-test.md, "Database connections").
4. **Was a setting changed?** If `DATABASE_URL` or the Neon password was
   changed recently, check Render's `DATABASE_URL` and `DIRECT_URL` match the
   strings Neon shows under **Connect**.

## Login codes (SMS) stop arriving

*Sentry alert `sms_failed` (each failed text), or riders say no code comes.*

1. **Moolre balance:** Sentry alert `moolre_balance_low`, or check the Moolre
   dashboard. **Top up.** This is the most likely cause.
2. **Render → Logs, search `sms_failed`:** each line has `httpStatus` and,
   when Moolre answered, `moolreCode` / `moolreMessage`. A `401`/`403` means
   the VAS key is wrong or was rotated (`MOOLRE_VAS_KEY`); a sender-ID
   message means `MOOLRE_SMS_SENDER_ID` isn't approved.
3. **"Moolre unreachable"** lines: Moolre is down or slow. Contact Moolre
   support; nothing to change on our side.
4. While codes don't go out, nobody new can sign in. People already signed in
   keep working.

## Push notifications stop

*Sentry alert `push_failures`; drivers say ride requests don't buzz.*

Push failing never breaks a ride: the apps also poll every 10–15 seconds, so
it's slower, not broken.

1. **[status.expo.dev](https://status.expo.dev):** Expo's push service down?
   Wait.
2. **Render → Logs, search `push: not accepted` / `push: not delivered`:**
   - `InvalidCredentials`: Android's FCM key or the iOS push key at Expo is
     missing or expired: re-upload it (docs/runbooks/push-notifications.md).
   - `MessageRateExceeded`: too many to one phone; it settles by itself.
   - Errors on every push after turning on "Enhanced Security for Push
     Notifications" at Expo: set `EXPO_ACCESS_TOKEN` on Render.
3. **Kill switch:** `PUSH_DISABLED=true` on Render stops all pushes without
   touching rides (useful if pushes go out wrong).

## A bad deploy

*Everything broke right after a deploy.*

1. **Render → `campusride-server` → Events** → find the last good deploy →
   **Rollback**. It's live again in a few minutes. This changes the code,
   not the database.
2. **If the bad change included a database migration**, rolling back the code
   leaves the migration in place. CampusRide's migrations only add things,
   so older code keeps working with them, but check the PR before rolling
   back past one.
3. Then fix it properly: revert the bad PR on GitHub (the PR page has a
   **Revert** button), merge the revert, and Render deploys it.

## A bad app update (over the air)

*An update broke the rider or driver app.*

Follow [Rolling back a bad update](releasing.md#5-rolling-back-a-bad-update):
one command republishes the previous update; phones pick it up the next time
the app opens. If no good update exists, roll back to the version built into
the store app.

## An admin account is compromised

*An admin sign-in you don't recognise in the admin site's **Admin logins**
tab; login codes you didn't ask for; your phone suddenly lost signal (a SIM
swap looks like that).*

Do these in order, quickly:

1. **Render → `campusride-server` → Environment → `ADMIN_PHONE_ALLOWLIST`:**
   remove the number. **Save.** After the redeploy (a couple of minutes),
   that number can't use the admin site or any admin route, whatever the
   database says.
2. **Sign everyone out:** set a new `JWT_SECRET` (`openssl rand -hex 32`).
   Every session ends, including the attacker's; riders and drivers simply
   sign in again.
3. **Call your mobile carrier** if your SIM may have been swapped.
4. **See what was done:** the admin site's **Admin logins** tab, then the
   admin audit log, which records driver approvals and rejections, place
   changes and rate-limit lookups and clears. Neon console → **SQL Editor**
   on `main` (this only reads):

   ```sql
   SELECT timestamp, actor, action, target, reason FROM "AdminAuditLog"
   ORDER BY timestamp DESC LIMIT 100;
   ```

   Undo what shouldn't have happened; a driver approved by the attacker can
   be rejected again from the admin site.
5. **Rotate the other secrets** on the list in
   [admin-and-secrets.md](../security/admin-and-secrets.md#secrets-to-rotate-before-launch)
   if there's any chance they were seen.
6. When it's safe, add your number back (a new SIM if needed). The planned
   authenticator-app second factor makes a SIM swap alone not enough.

## A rider says they can't book: "you already have a ride"

A ride the driver never completed blocks its riders. The server completes
any ride still in progress after 3 hours (`RIDE_AUTO_COMPLETE_HOURS`), and
reports it to Sentry (`ride_auto_completed`). For a sooner fix, ask the driver
to open the app and complete the trip. A ride that hasn't started yet the
rider can always cancel themselves.

---

## Incident log

| Date | What happened | What fixed it |
|---|---|---|
| 2026-09-24 | Test rows written to production | [incident-2026-09-24](../incident-2026-09-24-test-rows-in-production.md) |
