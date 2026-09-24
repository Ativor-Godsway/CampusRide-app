# Phone number formats

Written for: anyone touching auth, SMS, USSD, or a script that looks a user up
by phone.

## The short version

`User.phone` is **not consistently normalized**. The column holds a mix of
formats, depending on which code path created the row. Always look users up
with `findUserByPhone` / `findUsersByPhone` (`src/services/user/findUserByPhone.ts`),
never with a bare `findUnique({ where: { phone } })`.

## The three forms in play

| Form | Example | Who produces it |
|---|---|---|
| Canonical | `+233548608146` | `normalizePhone()` |
| Local | `0548608146` | What a Ghanaian user actually types |
| MSISDN | `233548608146` | Moolre's USSD callback, and what Moolre's SMS API wants |

`src/lib/phone.ts` converts between them:

- `normalizePhone(input)` → `+233XXXXXXXXX` or `null`
- `toMsisdn(input)` → `233XXXXXXXXX` or `null`
- `phoneVariants(input)` → every equivalent stored form, canonical first

## Why the column is mixed

The **auth routes do not normalize**. `signup()` and `login()` in
`src/services/auth/authService.ts` use `input.phone` verbatim as the unique
key, so whatever the app sent is what got stored — usually the local form,
because that is how people type their number.

The **USSD and demo-OTP paths do normalize** (`findOrCreateRiderByPhone`,
`ussdHandler`, `services/demoOtp`), storing the canonical form.

So the same human can end up as **two rows**: one from the app
(`0548608146`) and one from USSD (`+233548608146`). `findUsersByPhone` exists
to surface that case rather than silently pick one.

## Sending SMS

Normalize at the transport, not at each call site. `sendMoolreSms` converts the
recipient with `toMsisdn` before building the request, so OTP delivery, USSD
notifications, SOS texts and the `SUPPORT_CONTACT_PHONE` backstop all send the
documented format regardless of what their caller happened to hold. A
non-Ghanaian number falls back to stripping a leading `+` and is still
attempted — best-effort delivery beats dropping an SOS.

**Moolre accepts the local form too.** Login codes sent to `0548608146` in
local format do arrive in production; this was confirmed with SMS enabled and
live traffic. So normalizing the recipient is a correctness fix, not a repair
of a broken send. It is still worth doing:

- `233XXXXXXXXX` is the documented contract. Local-form acceptance is
  undocumented behaviour that could change without notice, and it would change
  on the login path, where a silent failure locks everyone out.
- Our idempotency `ref` is derived from the recipient, so the same person
  reached via two stored formats produced two different refs.
- One canonical recipient makes delivery logs and support lookups match the
  number a human would search for.

## The fix this is a workaround for

The real fix is to normalize on the **write** side and backfill the column:

1. Call `normalizePhone` in `signup()` and `login()` (and reject what it
   rejects), so every new row is canonical.
2. Find rows that would collide once normalized:
   ```sql
   SELECT regexp_replace(phone, '^(\+?233|0)', '') AS subscriber,
          count(*), array_agg(phone), array_agg(id)
   FROM "User"
   GROUP BY 1 HAVING count(*) > 1;
   ```
3. Merge those by hand — they are the same person with two ride histories, and
   `Ride.riderId` is `onDelete: Restrict`, so neither row can just be deleted.
4. Only then backfill the rest and add a `CHECK (phone LIKE '+233%')`.

Step 3 is why this has not been done automatically: it needs a human decision
per duplicate, and getting it wrong loses somebody's ride or commission
history.
