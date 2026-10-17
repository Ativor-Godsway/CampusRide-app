# Account deletion

How a rider or driver deletes their CampusRide account, and exactly what
happens to their data. Written for the owner: use it to fill in the app
stores' data forms and to answer anyone who asks. Added 2026-10-16.

## In the apps

Rider or driver app → **Account** tab → **Delete account**. The screen says
what is deleted, what is kept and for how long, then:

1. **Send me a code to confirm** texts a 6-digit code to the account's own
   phone number.
2. The person enters it and taps **Delete my account**. They're signed out
   and back at the welcome screen.

**While a ride is going on, it's refused** with: "You have a ride going on.
Finish or cancel it first, then you can delete your account." (A driver with
a trip in progress gets the same.) No code is sent.

## By email (no app)

For someone who has uninstalled the app or can't sign in:
**https://campusride.app/delete-account** tells them to email
support@campusride.app with the account's phone number and "Delete my
account". An admin then uses the admin site's **Delete account** tab:

1. Type the phone number from the email and **Look up**. It shows the
   account's name, whether it's a rider or a driver, and when it joined — or
   "No account found".
2. **Send verification code** texts a 6-digit code to that number. The text
   says it's for deleting the account and asks them to reply to our email
   with it. It works for 30 minutes (a login code works for 5), and the
   number's usual code limits apply (one a minute, a few per day).
3. Type the code they email back and **Check code**. A wrong code is
   refused; 5 wrong tries burns it. A right one unlocks **Delete account**
   for 5 minutes.
4. **Delete account** (and confirm). It runs the same code as the app's own
   delete, so everything under "What happens" below applies unchanged.
5. Email them to say it's done (the website promises this).

Refused, with the reason shown: an admin's account (role ADMIN, or a number
on `ADMIN_PHONE_ALLOWLIST`), and anyone on a ride right now, rider or driver
— the same message as the app. Ask them to finish or cancel the trip first.

Every step is in the admin audit log, with which admin did it and when:
`account_deletion.lookup`, `.code_sent` / `.code_refused`, `.verify`
(code correct, wrong, expired…), `.delete_refused`, and the deletion itself
as `account.delete` with the admin as its actor. The phone number appears
only masked (`+233*****146`) and the code never does, because the audit log
is kept for good and the number must be erased after 90 days.

## What happens

**Straight away**

- They can't sign in to the account again; every session on every phone
  ends, and their live connection is closed.
- Their name and phone number are replaced with "Deleted user" everywhere:
  the other people on their past trips, drivers and the admin site no longer
  see them. Their phone number is free at once: they can sign up again with
  it, starting a new, empty account.
- Notifications stop (push tokens deleted), SOS tracking links stop working,
  their emergency contact is removed, pending login codes are deleted.
- A driver leaves dispatch: offline, unapproved, plate and photo removed
  from their profile, and gone from the admin site's pending-driver list.
- An entry is written to the admin audit log (`account.delete`; its actor
  is the person, or the admin who deleted it on an emailed request).

**Kept for 90 days, then erased** (`ACCOUNT_DELETION_RETENTION_DAYS`)

- Their name, phone number and, for a driver, car plate and photo, held in a
  separate table that nothing in the apps or the admin site shows, only for a
  safety report or a police request about a trip they took.
- After 90 days the server erases those, together with their free-text notes
  (pickup notes, cancel reasons they typed), their exact pickup and drop-off
  points, their rating comments, and a driver's photo on Cloudinary. An
  audit log entry records it (`account.purge`).

**Kept without a name**

- Trip records: when, which zones, the fare, the stars given. They're the
  service's books and statistics; nothing in them identifies the person once
  the 90 days are over.
- A driver's cash commission records (what they owe or paid).
- The audit log entries saying the account was closed and erased.

## For the app store forms

- **Apple (App Store Connect):** account deletion is available in the app.
  Nothing else is needed.
- **Google Play (Data safety → Data deletion):** Google also asks for a
  **web link** where someone can ask for deletion without the app (for
  example, if they've already uninstalled it). Use
  **https://campusride.app/delete-account** (`apps/web`). It describes the
  in-app flow and the no-app route: email support@campusride.app with the
  account's phone number and "Delete my account"; we confirm with a texted
  code and finish within 30 days, from the admin site (see
  [By email](#by-email-no-app)).
- **Data kept after deletion:** "Trip records are kept without your name.
  Your name, phone number, and a driver's plate and photo are kept for 90
  days for safety and legal requests, then erased."

## For developers

- Server: `apps/server/src/services/auth/deleteAccount.ts` (`deleteAccount`,
  `purgeDeletedAccounts`, run hourly and at startup), routes
  `POST /me/deletion-code` and `DELETE /me` in `routes/auth.ts`. Both they
  and the admin routes in `routes/adminAccountDeletion.ts` close an account
  with `closeAccount`, so the two can't drift apart.
- Admin site: `apps/admin/src/screens/DeleteAccountScreen.tsx`.
- Apps: `packages/mobile-shared/src/auth/screens/DeleteAccountScreen.tsx`,
  shown at `/delete-account` in both apps.
- The 90 days is `ACCOUNT_DELETION_RETENTION_DAYS` in `@rida/shared`, so the
  screen's wording and the server's default agree.
