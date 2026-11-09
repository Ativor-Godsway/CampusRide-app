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

## Cash owed (Finances)

Riders pay drivers in cash; drivers owe CampusRide 15% of each fare. All
money is integer pesewas, and no row is ever edited or deleted.

```
still owed (a driver, all time) = Σ CommissionLedger.amountPesewas     (COMMISSION: one row per completed cash ride)
                                 − Σ DriverCashPayment.amountPesewas   (PAYMENT, WAIVER, ADJUSTMENT; reversals are negative)
                                 = commissions − payments − waivers (− adjustments)
```

- A **cancelled ride** has no ledger row, so it owes nothing.
- **Payments** (`kind` PAYMENT) are cash handed over in person (an admin
  records it: "Mark as paid" on the Driver page, or "Record payment" on
  Finances; method Cash, MoMo or Other) or paid by the driver in the app
  through Paystack (method `PAYSTACK`, recorded by "paystack" once Paystack
  confirms it).
- **Waivers** (`kind` WAIVER) forgive some or all of a balance, with a
  required reason, saved with the admin: one driver at a time (never more
  than they owe), or **Waive all balances** for the commission-free launch.
  Commission recorded after a waiver stays owed. **Adjustments** are
  reserved for corrections; nothing writes them yet.
- A **partial payment** recorded by an admin simply lowers the balance.
  Paying more than owed leaves a negative balance, shown as "paid ahead".
  In the driver app a driver always pays the **whole** balance.
- A mistake is put right by a **reversal**: a new row of the same kind with
  the amount negated, `reversesId` pointing at the original and a required
  reason. A row can be reversed once; a reversal can't be reversed.
- **Still owed to CampusRide** (the hero) = the sum of every driver's balance
  that is above zero.
- **Oldest unpaid** = payments and waivers pay off the oldest commission
  first; the earliest ledger row not yet covered.
- In the period (by `paidAt`): **Commission earned** = commission of trips
  completed in the period. **Collected** = payments (and their reversals),
  split into **via Paystack** and **in person**. **Waived** = waivers (and
  their reversals). **Paystack fees paid by drivers** = the fee drivers added
  on top of their balance on confirmed Paystack payments (what Paystack
  reports it kept is shown beside it).
- **Status** on a driver's row: **Paid** when they owe nothing now; **Part
  paid** when they still owe but paid something in the period; **Not paid**
  otherwise.

### Paying in the driver app (Paystack)

- **Fee.** The driver pays `gross = ceil(owed ÷ (1 − rate))`, but never more
  than `owed + cap` when the fee is capped, so CampusRide receives the whole
  balance after Paystack's fee. The rate and cap are admin settings (Settings
  → Driver commission), starting from `PAYSTACK_FEE_PERCENT` /
  `PAYSTACK_FEE_CAP_GHS`. Balances under GH₵1 can't be paid in the app.
- **The amount is locked** when the payment starts
  (`DriverPaystackPayment.owedPesewas`). Commission from a trip that ends
  during the payment stays owed; only the locked amount is cleared.
- **Only Paystack says "paid".** A payment is credited when Paystack's
  verify endpoint says success for our reference, in GHS, for exactly the
  gross asked: reached from the webhook (`charge.success`, after its
  HMAC-SHA512 signature checks out) or from the app's status checks. A
  reference is credited at most once. Anything that doesn't match is marked
  **MISMATCH** and never credited by itself.
- MoMo goes through Paystack's charge API (MTN, Telecel, AirtelTigo; the
  driver approves on their phone, or enters a code when the network asks).
  If Paystack refuses the charge outright, the app opens Paystack's hosted
  checkout page instead. Only the number's last 4 digits are kept.

### Limits (Settings → Driver commission)

- **Debt limit** (default GH₵100) and **warning level** (default 80% of it).
- **Enforcement** (default off, for the commission-free launch). Off:
  commission still adds up, but nobody is warned or blocked. On: the driver
  app warns from the warning level ("You owe GH₵85. Pay before GH₵100 to keep
  driving."), and a driver who owes the limit or more is refused **going
  online** (`COMMISSION_LIMIT`). A driver already online is never taken
  offline, and one with a trip under way is never blocked or interrupted.

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
