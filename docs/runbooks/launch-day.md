# Launch day

The order of things on the day CampusRide opens, written to be followed step
by step. Read it once the day before, and have these open in browser tabs:

- App Store Connect: [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
- The admin site: [campusride-admin.onrender.com](https://campusride-admin.onrender.com)
- Render: [dashboard.render.com](https://dashboard.render.com) → `campusride-server`
- Sentry: [sentry.io](https://sentry.io) → the `campusride` organization
- Neon: [console.neon.tech](https://console.neon.tech) → the CampusRide project
- UptimeRobot: [uptimerobot.com](https://uptimerobot.com)

**Where things stand (checked 2026-11-10):** launch mode is a **countdown to
Monday 16 November 2026 at 7:00 PM Ghana time**. At that moment CampusRide
goes live **by itself**, with nobody pressing anything. Both iOS apps are
"Pending Developer Release" (rider 1.0 build 8, driver 1.0 build 4). Google
Play comes later.

## The day before

1. Go through [render-env-checklist.md](render-env-checklist.md) once,
   especially `PAYSTACK_SECRET_KEY` (must start `sk_live_`) and
   `DRIVER_OFFER_SECONDS=20`.
2. Neon → the project → **Billing** (or **Usage**): note the compute hours
   used this month. On the free plan (100 hours) this server uses about 6 a
   day. If you're above about 60, upgrade before launch, or the database is
   suspended mid-month and the app stops ([DEPLOY.md](../../DEPLOY.md#8-neon-check-compute-hours-every-week)).
3. Moolre dashboard ([app.moolre.com](https://app.moolre.com)): check the SMS
   balance. Every sign-up and sign-in costs a text. Top up generously.
4. Charge your phone and have both apps installed from TestFlight, signed in
   with a normal (not demo) account.

## On the day, in this order

### 1. Take a backup branch (5 minutes)

1. Neon → the CampusRide project → **Branches** → **New branch**.
2. **Parent branch:** `main` (production).
3. **Name:** `backup-YYYY-MM-DD` with today's date, e.g. `backup-2026-11-16`.
4. Include: **Current data**.
5. **Untick "Automatically delete branch after"**, or it deletes itself.
6. **Create.**

More on backups and restoring: [backup-and-restore.md](backup-and-restore.md).

### 2. Release both apps in App Store Connect

1. App Store Connect → **Apps** → **CampusRide** → under iOS App, version
   **1.0** ("Pending Developer Release") → **Release This Version** →
   confirm.
2. The same for **CampusRide Driver**.
3. Apple takes from a few minutes to a few hours (sometimes up to a day) to
   show the apps in the store. Nothing else changes while you wait: the
   server, launch mode and the website are already set.

Releasing early is fine: people who download the apps before 7:00 PM can
sign up and look around, and see the countdown on Home. Drivers can register
and go online.

### 3. Check the links (once the apps are in the store)

On an iPhone (not on Wi-Fi you share with a Mac signed in to App Store
Connect, which can show a stale page):

1. Open `https://campusride.app/get`: it should jump straight to the
   **CampusRide** App Store page.
2. Open `https://apps.apple.com/app/id6827179216`: the **CampusRide Driver**
   page.
3. On an Android phone, `https://campusride.app/get` stays on the page and
   shows the App Store badge and **Coming soon to Google Play**.
4. On a computer, `https://campusride.app` shows the App Store badge in both
   the rider section and the "Drive with CampusRide" section.

Until Apple finishes publishing, the App Store links answer "not found":
that's normal, wait and try again.

### 4. Launch mode: let it go live, or go live early

What riders and drivers see **during the countdown** (now):

| | During the countdown |
|---|---|
| New people sign up (rider or driver) | **Yes**, as normal |
| Drivers register their car and get approved | **Yes**: approve them in the admin site as normal |
| Drivers tap **Go online** | **Yes**, it works as normal; they see a small countdown reminder on Home |
| Riders see | A countdown on Home, to the launch time |
| Riders book a ride | **No.** They're told when CampusRide opens. Except: riders you gave **early access**, admins and the review demo accounts, who can book |

At the launch time, booking opens for everyone. You don't need to do anything.

- **To launch at the planned time (7:00 PM, 16 November):** do nothing.
- **To launch now instead:** admin site → **Settings** → **Launch mode** →
  **Live** → **Save launch mode**.
- **To move the time:** Settings → Launch mode → **Countdown**, pick the new
  date and time (Ghana time) → Save.

What changes, and how fast:

- **The server** sees the change at once (another server instance within 10
  seconds).
- **Phones** pick it up within a minute, or when the app is reopened. **No
  app update and no deploy is needed**: the apps ask the server.
- **Optional:** the launch notification, sent once at the moment of launch:
  Settings → **Launch notification** → tick **Send "CampusRide is live!"
  when launch mode turns Live** (before you go Live). Details:
  [launch-mode.md](launch-mode.md#the-launch-notification).

### 5. Watch for the first hours

Keep these open and look every 15–30 minutes for the first evening:

- **Sentry** → Issues, all four projects (`campusride-server`,
  `campusride-rider`, `campusride-driver`, `campusride-admin`). A burst of a
  new issue is the signal. One-off network errors are normal.
- **Render** → `campusride-server` → **Metrics**: CPU and memory. CPU
  staying above about 70% means it's time for a bigger plan. **Logs**:
  search for `"level":"error"`.
- **Admin site** → **Overview** and **Live map**: rides being booked,
  drivers online. **Safety**: any SOS. **Settings → Admin sign-ins**: only
  your own sign-ins.
- **UptimeRobot**: the `/health/ready` monitor stays **Up**.

## If something goes wrong

Full instructions for each are in [incidents.md](incidents.md). The short
version:

### The server goes down

*UptimeRobot says Down; the apps can't connect.*

1. Render → `campusride-server` → **Events**: did a deploy just happen?
   If a deploy *failed*, the old version is still running. If one
   *succeeded* just before it went down, roll it back: **Events** → the
   previous successful deploy → **Rollback**.
2. Render → **Logs**: `Refusing to start: …` names the missing setting.
   Fix it under **Environment**.
3. Nothing obvious: **Manual Deploy → Restart service**, and check
   [status.render.com](https://status.render.com) and Neon's status.
4. Riders and drivers on a trip: the trip is kept in the database; the
   apps reconnect by themselves when the server is back.

### A bad over-the-air update ships

*Sentry shows a new crash in one app right after you published an update.*

```bash
cd apps/rider          # or apps/driver
npx -y eas-cli@24 update:list --branch production
# copy the bad update's group ID (one per platform; iOS and Android are separate)
npx -y eas-cli@24 update:rollback <BAD_GROUP_ID> -m "Roll back: what went wrong"
```

That republishes the update before it. Phones get it the next time the app
opens. If even that is bad, the last resort sends every phone back to the
code built into the store version:

```bash
npx -y eas-cli@24 update:roll-back-to-embedded --channel production -m "Back to store version"
```

Details: [releasing.md](releasing.md#5-rolling-back-a-bad-update).

### Login codes (SMS) stop arriving

*New people can't sign up; Sentry has `sms_failed` alerts.*

1. Moolre dashboard: is the SMS balance zero? Top up. Codes start arriving
   again at once.
2. Still failing: Render → Logs, search `sms`. Contact Moolre support with
   the time it started.
3. People already signed in keep using the app; they don't need a code.
   SOS still records and alerts in the admin site, but its texts to
   emergency contacts and `SUPPORT_CONTACT_PHONE` need SMS too, so watch
   **Safety** in the admin site until SMS is back.

### Paystack fails (drivers can't pay their commission)

1. Nobody is blocked: commission enforcement is **off** for launch, so a
   driver who can't pay can still go online.
2. Paystack dashboard → **Transactions**: are payments arriving? →
   **Settings → API Keys & Webhooks**: the live webhook URL must be
   `https://api.campusride.app/webhooks/paystack`.
3. A driver who paid but whose balance didn't drop: the app checks again
   by itself. If not, admin site → **Finances** → the driver → record the
   payment by hand, with the Paystack reference in the note.
4. Admin site → **Settings → Driver commission**: a red line there says if
   the key is missing or a test key.

### Going back to the countdown

Admin site → **Settings** → **Launch mode** → **Countdown**, choose a time
in the future → **Save launch mode**. Within a minute, riders without early
access can't book new rides again. Rides already booked or under way carry
on. **Off** means everyone can book, with no countdown.

## After launch

- **Every week:** a new `backup-…` branch (keep the last four), Neon compute
  hours, Moolre SMS balance.
- **When Google Play approves the production release:** Render →
  `campusride-server` → Environment → `REVIEW_DEMO_ENABLED` = `false` → Save.
  The two review numbers then sign in like anyone else (by texted code, which
  nobody receives), and the demo's simulated driver stops. Turn it back on
  for any later store review that needs it.
- **When the Play links exist:** paste them into `apps/web/site.config.mjs`
  (`stores.rider.googlePlay`, `stores.driver.googlePlay`) and deploy the
  website; "Coming soon" disappears.
