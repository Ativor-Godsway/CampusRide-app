# Launch mode (countdown before the public launch)

The apps can be in the stores before launch day. Until launch, riders can sign
in and look around (places, prices), but only some accounts can book, and
everyone else sees a countdown. Set in the admin site: **Settings → Launch
mode**. Times are Ghana time (GMT, which is UTC all year).

| Mode | Who can book | What riders see |
|---|---|---|
| Off | Everyone | Nothing new (this is how it starts) |
| Countdown | Early-access riders, review demo accounts, admins | Home: a countdown card. Choose a ride: the button says "Opens in 2d 4h" and can't be pressed |
| Live | Everyone | Nothing new |

At the launch time a countdown becomes Live **by itself**: nothing has to be
pressed, the server compares the launch time with its clock on every request.
The card disappears from phones within a few seconds of the launch time, with
no restart. The countdown runs on the server's clock, so a phone set to the
wrong time still shows the right countdown.

During the countdown the server refuses other riders' bookings with
"CampusRide opens on Saturday 14 November at 9:00 AM. See you then!". Older app
versions show the same sentence: they already show the server's own words for
this kind of refusal.

Drivers are not blocked: approved drivers can go online during the countdown
(to drive early-access riders) and see "Public launch in …" on Home.

## Who can book during the countdown

- **Review demo accounts** (`REVIEW_DEMO_*`): App Store and Google Play
  reviewers must always be able to book, or the app is rejected as "coming
  soon only".
- **Admins.**
- **Early access**: a flag per rider, in Settings → Early access. Look up a
  rider by phone number to give or take it away, or press **Give early access
  to all current riders** once: every rider account that exists at that moment
  gets it (the pilot testers). People who sign up afterwards don't.
  Only rider accounts can have it: drivers don't book, and one phone number is
  one account.

Every change (mode, launch time, early access, the "all riders" button) is in
the audit log: `launch.update`, `early_access.grant`, `early_access.revoke`,
`early_access.grant_all`.

## Turning it on

1. Settings → Early access → **Give early access to all current riders**.
2. Settings → Launch mode → **Countdown**, choose the date and time (Ghana
   time) → **Save launch mode**.
3. Check with a phone that has no early access: Home shows the countdown.

Phones pick a change up within a minute (or when the app is reopened).

**To undo:** Settings → Launch mode → **Off** (or **Live**). Everyone can book
again within a minute.
