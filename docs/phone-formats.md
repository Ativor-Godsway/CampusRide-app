# Phone number formats

Written for: anyone touching auth, SMS, USSD, or a script that looks a user up
by phone.

## The short version

`User.phone` is **always** canonical `+233XXXXXXXXX`. The auth routes normalize
at the edge (`routes/auth.ts`) and a CHECK constraint enforces it. To look a
user up from a number that came from a human or an external system, use
`findUserByPhone` / `findUsersByPhone` (`src/services/user/findUserByPhone.ts`),
which accepts any spelling.

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

## Why the column used to be mixed

The auth routes did not normalize: `signup()` and `login()` used `input.phone`
verbatim as the unique key, so whatever the app sent was stored — usually the
local form, because that is how people type their number. The USSD and
demo-OTP paths *did* normalize.

That produced **shadow accounts**. A rider signed up in the app as
`0548608146`; later they dialled the USSD line; `findOrCreateRiderByPhone`
normalized their number to `+233548608146`, found no match, and created a
second account. Production held three such pairs — in every case a real named
account in local form plus a later auto-provisioned `USSD Rider`.

Migration `20260924210000_phone_canonicalisation` merged those pairs
(repointing the shadow's rides onto the real account, then removing the
shadow), backfilled the column, and added the constraint. The route-level
normalization stops new ones being created.

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

## The constraint

```sql
ALTER TABLE "User" ADD CONSTRAINT "User_phone_canonical_check"
  CHECK (phone LIKE '+233%' OR phone LIKE 'deleted:%');
```

The `deleted:%` arm is **required**, not a convenience: `DELETE /me` rewrites
`phone` to `deleted:<userId>` (see `services/auth/deleteAccount.ts`) to keep
the unique index satisfied while making the row unloggable-into. Without that
arm every future account deletion would fail.

## Consequences for test fixtures

Fixtures can no longer invent phone strings like `+233-auth-test-123`. Both the
route validation and the CHECK reject them. Use `uniqueGhanaPhone()` from
`src/test/testPhone.ts`, which produces structurally valid, unique numbers.

## If a duplicate ever appears again

It should not — the unique index plus the CHECK make two equivalent rows
impossible. But if one does, `findUsersByPhone` returns both and `seedAdmin`
refuses to act rather than promoting an arbitrary one. Find them with:

```sql
SELECT regexp_replace(phone, '^(\+?233|0)', '') AS subscriber,
       count(*), array_agg(phone), array_agg(id)
FROM "User"
WHERE "deletedAt" IS NULL AND phone NOT LIKE 'deleted:%'
GROUP BY 1 HAVING count(*) > 1;
```
