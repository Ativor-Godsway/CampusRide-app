# Admin dashboard: what every number means

Written for: the owner and anyone changing the admin dashboard or its server
endpoints. The code follows this page exactly; if they ever disagree, the
page is the specification and the code is the bug.

Where it lives: the arithmetic in
[apps/server/src/services/admin/metrics.ts](../apps/server/src/services/admin/metrics.ts)
(tested in `metrics.test.ts`), the rows it reads in
[services/admin/facts.ts](../apps/server/src/services/admin/facts.ts), cash in
[services/admin/cash.ts](../apps/server/src/services/admin/cash.ts), and the
endpoints in `routes/adminDashboard.ts`, `adminInsights.ts`, `adminPeople.ts`
(tested with a seeded week in `routes/adminDashboard.test.ts`).

## Time

- **Every day and hour is Accra time.** Ghana is on GMT all year (no daylight
  saving), so Accra time is UTC. A day runs 00:00–24:00 GMT; "6 pm" is the
  hour 18:00–19:00 GMT.
- **Weeks start on Monday.**
- A **period** is `[from, to)`: it includes `from` and stops just before `to`.
  The admin site sends whole Accra days. One request may cover at most 400
  days.
- **Compared with last week** = the same period shifted back exactly 7 days.
  For "Today" (a Saturday) that is last Saturday; for "This week", last week.

## Requests

- A **request** is a ride request (a `Ride` row) created in the period. Every
  rider's own request counts once, including one a driver later added to a car
  that was already going (the request is merged into that car's ride).
  Review demo rides (App Store / Play reviewers) are never counted, anywhere.
- **Rides today** on the Overview is the number of requests made today.
- **Got a driver** = a driver took it (`matchedAt` is set), or added the rider
  to their car (the request was merged: `cancelReason = MERGED_INTO_ANOTHER_RIDE`).
- **No driver found** = its offer window ran out with nobody taking it
  (`noDriverFoundAt` is set). Rides from before that column existed
  (2026-10-30) count when they ended `NO_DRIVERS_AVAILABLE` or are still
  waiting for the rider's decision with no driver. A request can be both "no
  driver found" (the first window passed) and "got a driver" (the rider kept
  waiting and one came).
- **Time to get a driver** = the median of (when it got a driver − when it was
  requested), over requests that got one. When merged into a car, "when it got
  a driver" is the moment it was merged.

## Money

All amounts are stored as integer pesewas and shown as `GH₵15`, `GH₵12.75`,
`GH₵1,212` (no space, no decimals for whole cedis). One helper does it:
`cedis()` in `apps/admin/src/lib/money.ts`.

- **Fares collected** = the sum of the **stored** fares of trips completed in
  the period (`Ride.completedAt` in the period): for a shared ride, each seat
  that was dropped off; for a ride alone, its one seat. A seat's fare is
  `fareCharged` (set at drop-off), else `lockedFare` (the price the rider was
  shown). Never worked out again from today's price list. Cancelled seats and
  cancelled rides pay nothing.
- **CampusRide 15%** = the stored commission: `CommissionLedger.amountPesewas`,
  written once when a cash ride completes, as `round(15% × the ride's paid
  fares)`. (It is stored **per ride**, not per seat; a shared ride's 15% is of
  all its seats together.) A completed ride with no ledger row (none should
  exist) counts 15% of its stored fare.
- **Driver earned** = fares − CampusRide's 15%, for the driver's trips
  completed in the period (the driver's 85%).

## Cash owed

Riders pay drivers in cash; drivers owe CampusRide 15% of each fare.

```
still owed (a driver, all time) = Σ CommissionLedger.amountPesewas (their completed cash rides)
                                 − Σ DriverCashPayment.amountPesewas (their payments; reversals are negative)
```

- A **cancelled ride** has no ledger row, so it owes nothing.
- A **partial payment** simply lowers the balance. Paying more than owed leaves
  a negative balance, shown as "paid ahead".
- Payments are **never edited or deleted**. A mistake is put right by a
  **reversal**: a new row with the same amount negated, `reversesId` pointing
  at the original and a required reason. A payment can be reversed once; a
  reversal can't be reversed (record a new payment instead).
- **Still owed to CampusRide** (the hero) = the sum of every driver's balance
  that is above zero.
- **Oldest unpaid** = payments pay off the oldest commission first; the
  earliest ledger row not yet covered by a driver's payments.
- **15% earned in the period** = commission of trips completed in the period.
  **Paid in the period** = payments (and reversals) dated in the period
  (`paidAt`, which the admin chooses; default: when recorded).
- **Status** on a driver's row: **Paid** when they owe nothing now; **Part
  paid** when they still owe but paid something in the period; **Not paid**
  otherwise.

## Drivers

- **Hours online** = the sum of `DriverOnlineSession` durations **clipped to
  the period**. A session that crosses midnight counts in both days, each its
  own part. A session still open counts up to now.
- **Drivers online per hour** (Overview chart) = how many different drivers
  were online at some point in that hour.
- **Driver-hours online per hour** (Supply & demand) = the online time inside
  each hour of the day, added up over every driver and every day of the period.
- **Acceptance rate** = accepted ÷ (accepted + declined + timed out). "Taken by
  another driver", "cancelled by the rider", "expired" and offers still open
  don't count against the driver.
- **Average reply** = the mean time from an offer to the driver's own answer
  (accepted or declined). A time-out is not a reply.
- **Cancelled by driver** = their rides cancelled with `DRIVER_BACKED_OUT`.
- **Rating** = the average stars drivers received from riders, all time.
- **Now**: Suspended, Needs approval, On trip (a ride of theirs is matched,
  arrived or under way), Online, Offline.

## Cancellations

- A **cancellation** is a request whose ride ended `CANCELLED`, except one
  merged into a car (that rider got a driver). A rider cancelling only their
  own seat in a shared car that went on is not a cancelled ride.
- **Who**: **rider** (`RIDER_CANCELLED`, and `ALL_PASSENGERS_LEFT` — every
  rider in the car left), **driver** (`DRIVER_BACKED_OUT`), **system**
  (`NO_DRIVERS_AVAILABLE`: nobody took it / it expired).
- **Why** = the rider's own answer in the app's cancel sheet when there is one,
  otherwise the system's reason.
- **Before / after a driver took it** = whether the request had a driver
  (`matchedAt` or a driver on the ride) when it was cancelled.
- **% of requests** = cancellations ÷ requests in the period.

## Supply & demand verdict

For each **pickup zone** and each **3-hour window** of the day (7–10 am,
10 am–1 pm, 1–4 pm, 4–7 pm, 7–10 pm, 10 pm–1 am, 1–4 am, 4–7 am), over the
whole period:

- if **at least 15%** of the requests made there and then found **no driver**,
  **and** there were **at least 3** requests → **"Need N more drivers <window>"**,
  where

  ```
  N = ceil( no-driver requests ÷ max(1, average completed trips per online driver-hour in that window) )
  ```

  capped at **5**. "Average completed trips per online driver-hour" is for the
  whole campus in that window: trips completed (counted by when they were
  requested) ÷ driver-hours online in those hours of the day, over the period
  (0 when nobody was online, so N = the no-driver count, up to 5);
- otherwise **"OK"**.

A zone shows its worst window (largest N; then most no-driver requests; then
the earliest window); the others are in the chip's tooltip. Chips: amber for
1 driver, red for 2 or more, green for OK.

**The suggestion line** at the top applies the same rule to the whole campus:
of the windows where some zone needs drivers, the one where
`ceil(all its no-driver requests ÷ max(1, trips per driver-hour))` (capped at
5) is largest — "Ask 2 more drivers to be online Fri and Sat, 4–7 pm." The
days named are the weekdays carrying at least a fifth of that window's
no-driver requests (at most three, in week order; "every day" when all seven).
With no window needing drivers: "No changes needed".

## Riders

- **Riders** = open rider accounts (not closed, not review demo).
- **New this period** = rider accounts created in the period.
- **Active this period** = riders with at least one completed ride in the
  period (a seat not cancelled, on a ride completed in the period).
- **Returning** = riders with at least two completed rides ever; the
  percentage is of riders who have completed at least one.
- Lists show phone numbers masked (`+233*****146`); the full number is only in
  that rider's detail panel.

## When there's nothing to count

A rate with nothing to divide by (no requests, no offers) shows **"—"** with
the tooltip "Not enough data yet", never 0%.

## How fresh the numbers are, and what they cost

- Every aggregate (Overview, Supply & demand, Cancellations, Drivers, Cash
  owed, Riders' totals, Places, Safety) is computed at most **once a minute**
  for the same question (endpoint + period), however many admins or tabs ask
  (`services/admin/cache.ts`). Recording a payment, suspending a driver or
  marking an SOS handled clears it, so the change shows at once.
- The pages ask again every 60 s while the browser tab is visible, and not at
  all while it's hidden.
- The **live map** asks every 5 s, and is answered from the server's memory
  (drivers' live positions and app status, requests waiting for a driver).
  Who the online drivers are and the trips under way are read from the
  database at most once a minute, shared by everyone. So an open live map costs
  the database nothing extra beyond that once-a-minute read.
- Live positions and waiting requests are lost when the server restarts; they
  come back within seconds as apps reconnect and riders' requests are offered
  again.
