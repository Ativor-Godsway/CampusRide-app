# Admin dashboard: how to use it

Written for: whoever runs CampusRide day to day from the admin site
(campusride-admin). What each page is for, and step by step how to record
cash, suspend a driver, handle an SOS and read Supply & demand. What each
number means exactly: [docs/admin-metrics.md](../admin-metrics.md).

Every page has its own address (you can bookmark or share it), refreshes by
itself once a minute while the tab is open (the live map every 5 seconds),
and has a **Refresh** button with "Updated … ago" beside it. Times are Ghana
time (GMT). On an iPhone the menu is the bar at the bottom; **More** holds the
pages that don't fit.

## The pages

| Page | What it's for |
|---|---|
| **Overview** | Today at a glance. Alerts appear only when something needs you: requests that found no driver, an open SOS, drivers waiting for approval, the database unreachable. |
| **Live map** | Every online driver (green waiting, dark on a trip, pointing where they're heading), riders waiting for a driver (amber pulse) and trips under way. Click a car or a request for its details. |
| **Rides** | Every ride, filtered by period, status, type, zone, driver, rider phone or ride ID. Click one for its full story: who was offered it and how they answered, who rode and paid what, the route, ratings, SOS. **Download CSV** for the period (up to 92 days). |
| **Supply & demand** | "Do I need more drivers, and when?" See below. |
| **Cancellations** | How many, who cancelled, why, and when. Filter the list by who. |
| **Drivers** | Every driver's trips, hours online, earnings (their 85%), acceptance and rating. **Needs approval** is the approval queue. Click a driver for earnings, sessions, offers, the location trail, and suspending. |
| **Cash owed** | What drivers owe CampusRide (15% of cash fares) and recording what they hand over. |
| **Riders** | Sign-ups and returning riders; every rider (phones masked). Click a rider for their rides, ratings, SOS, early access, rate limits and deleting their account. "For any phone number" has the same rate-limit and deletion tools for a number with no account. |
| **Places** | Where rides start and end, the busiest places, and the place editor (unchanged). |
| **Safety** | Open SOS alerts first, then handled ones; 1–2 star ratings with comments. |
| **Notifications** | Send a push notification (unchanged). |
| **Settings** | Launch mode and early access, the launch notification, your passkeys, admin sign-ins, the audit log, and facts about the system (app minimum versions, review demo mode, server version, last deploy). |

The **search box** at the top takes a phone number, a ride ID, or a driver's
name or plate, and jumps to the match.

## Record a cash payment

1. **Cash owed** → find the driver under **By driver**.
2. **Record payment**. The amount starts at what they still owe; change it for
   a part payment.
3. Choose how they paid (Cash, MoMo, Other), check the date and time it was
   paid, and add a note if useful (a MoMo reference).
4. **Record**. It appears under **Payments recorded** with your name, and in the
   audit log.

Made a mistake? Payments can't be edited or deleted. Under **Payments
recorded**, **Reverse** the wrong one, say why, then record the right one. The
reversal is a negative entry; the original stays visible, marked "Reversed".

## Suspend a driver

1. **Drivers** → click the driver → **Suspend driver**.
2. Write why (it's saved in the audit log) → **Suspend**.

They're taken out of dispatch at once (no new requests) and can't go online
until you lift it: their app says "Your driver account is suspended, so you
can't go online…" when they try. A trip they're on carries on. Their approval
is kept. If they were online when you suspended them, their app may still show
"online" until they next switch it: the server doesn't message the phone (the
apps are unchanged by this release), so call them if they need to know now. To undo: open them (the **Suspended** tab lists them) →
**Lift suspension**, with a reason.

Rejecting a new driver is different: that's the **Needs approval** tab, as
before.

## Handle an SOS

An open SOS shows on the Overview (red), as the red number beside **Safety**,
and first on the Safety page.

1. **Safety** → read the alert: the rider, the ride (click for its live
   details), where the car last was, and who was texted (the rider's
   emergency contact, if they saved one, and the support number).
2. Act: call the rider, the driver, or emergency services (112) as needed.
3. **Mark handled** and write what was done. Your note, name and the time are
   saved on the alert and in the audit log. It can only be marked once.

## Read Supply & demand

1. Pick the period (default **This week**; a month gives steadier numbers).
2. The tiles: how many asked, what share got a driver, how long that usually
   took, and how many found none.
3. **When riders couldn't get a driver**: each square is a weekday and hour;
   darker means more requests went unanswered. Switch to **All requests** to
   see when people ask at all.
4. **Requests vs driver-hours online**: where the green line (requests) runs
   above the brown one (driver-hours), demand outruns drivers.
5. **By pickup zone**: the verdict says how many more drivers a zone needs in
   its worst 3-hour window ("Need 2 more drivers 4–7 pm"), or OK.
6. The **Suggestion** at the top turns it into one action: "Ask 2 more drivers
   to be online Fri and Sat, 4–7 pm". Ask drivers by Notifications → Drivers.

The rule behind the verdicts is in [admin-metrics.md](../admin-metrics.md#supply--demand-verdict).

## See where a driver was

Drivers → click the driver → **Location trail** → choose the day → **See
location trail**. Viewing it is recorded in the audit log with your name.
Trails are kept 90 days, as the privacy policy says.

## Try it with made-up data (on your Mac, never production)

```bash
npm run db:deploy:dev --workspace=apps/server       # local database up to date
npm run seed:dashboard:dev --workspace=apps/server  # two weeks of pilot-like data
npm run dev:server                                  # API on :3000
npm run dev:admin                                   # admin site on :5173
```

Sign in as **Seed Admin** (the number is printed by the seed; the code is in
the server log). The seed refuses to run against anything but the local
database, and running it again replaces only what it made.
