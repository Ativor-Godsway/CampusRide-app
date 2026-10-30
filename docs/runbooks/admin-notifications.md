# Admin notifications

The admin site's **Notifications** tab sends a push notification you write
yourself. Code: `apps/server/src/services/push/broadcast.ts`.

## Sending one

1. Write a **title** (at most 50 characters) and a **message** (at most 150).
2. Choose who gets it: **All riders**, **All drivers**, **Everyone**, or **One
   phone number** (any spelling: 024…, +233…).
3. Press **Review and send…**. The box shows the exact text and how many
   devices (app installs with notifications allowed) get it right now.
4. **Send now**. It goes out in the background, 500 devices at a time; the
   history's counts fill in as it goes.

Who never gets one: closed accounts, App Store / Google Play review demo
accounts, and phones that turned CampusRide notifications off. Riders get it
in the rider app, drivers in the driver app.

**Send test to me** sends only to a rider or driver account on your own phone
number. CampusRide allows one account per number, so while your number is your
admin account there is none, and the page says so instead of sending. To see a
notification on a real phone, send to **One phone number** with a rider or
driver account you can check.

## Limits

- At most **5** sends to all riders, all drivers or everyone per hour, and
  **10** single-number and test sends per hour, for all admins together. The
  page shows how many are used. They are counted from the history in the
  database, so a server restart doesn't reset them.
- The one-time launch push ([launch-mode.md](launch-mode.md)) counts toward
  neither.

## The history

Every send is listed with who sent it, when, the audience (a single number is
shown masked, `+233*****146`), the text, and how many devices it was sent to,
delivered and failed.

- **Delivered**: Expo's push service accepted it for the phone. If Apple or
  Google refuse it afterwards (reported about 15 minutes later), it moves to
  **Failed**.
- Phones Expo reports as gone (the app was uninstalled, or notifications were
  revoked) are removed from the list automatically, so the next send skips
  them.
- **Interrupted**: the server restarted in the middle of the send. Part of the
  audience got it; it is not resent automatically.

Every send is also in the audit log: `notification.send` or
`notification.test`, with the audience, device count and text. Push tokens and
full phone numbers are never written to the logs.

## What phones show

The notification opens the app. Today's app builds show it as a banner when
the app is in the background or closed; while the app is open on screen they
don't show it (they only show their own ride notifications in the
foreground).
