# Incident: test-fixture accounts in the production database

**Date:** 2026-09-24 · **Status:** contained, cleanup pending

## What happened

The `phone_canonicalisation` migration was run against production and **aborted
on its own precondition check**, reporting 353 phone numbers that are not
Ghanaian numbers and naming them — `+233-2a-test-…`, `+233-auth-test-…`. Those
are automated-test fixtures. Nothing was modified: the migration raises before
its first write, and the whole thing runs in one transaction.

So production contains roughly 353 accounts created by the test suite.

## How they got there

`apps/server/.env.test` used to point `DATABASE_URL` at a **Neon** host
(`ep-blue-union-…`). It now points at local Postgres, with the Neon URL left
commented out directly beneath it. Any test run made while that line was live
wrote fixtures wherever it pointed.

The hosts each env file targets today:

| File | Host |
| --- | --- |
| `.env` | `ep-ancient-butterfly-…` (Neon) |
| `.env.development` | `ep-flat-rain-…` (Neon) |
| `.env.test` | `localhost:5432/rida_test` — with `ep-blue-union-…` commented out below it |

### Why the guard did not catch it

It ran. It just could not see the problem.

`assertNotProdDatabase` was a **denylist naming exactly one host**:

```ts
export const PROD_DB_HOST = "ep-ancient-butterfly";
if (url.includes(PROD_DB_HOST)) throw ...
```

`.env.test` pointed at `ep-blue-union-…`, which is not that string, so the
check passed and the suite ran. A denylist fails **open**: it only stops the
one address it has heard of, and production addresses change — new accounts,
new branches, restores, renames. The guard protected against the database it
was written for, not against production in general.

## The fix

The guard is now an **allowlist** that fails closed (`src/db/dbHostGuard.ts`):

- local Postgres is always allowed;
- any other host is refused unless the operator names it exactly in
  `ALLOW_TEST_DB_HOST`;
- a known production host is refused **even if** someone names it;
- a missing or unparseable `DATABASE_URL` is refused rather than assumed safe.

`KNOWN_PROD_DB_HOSTS` lists both `ep-ancient-butterfly` and `ep-blue-union`.
The second is listed as production until proven otherwise — if it is genuinely
a disposable branch, remove it there deliberately rather than working around it.

`src/db/dbHostGuard.test.ts` pins all of it, including the exact case that
failed: an unnamed remote Neon host is now refused.

### Fixtures are now identifiable

Fixture phone numbers use the reserved prefix `+2330`, which passes validation
and the CHECK constraint but can never be a real Ghanaian subscriber number.
The only reason this incident is cleanable is that the old fixtures were
obviously fake; that property is now deliberate rather than accidental.

## Cleanup

Two groups, and they are **not** equally safe.

**Group A — unambiguous (353 rows).** Phones that are not valid Ghanaian
numbers (`+233-2a-test-…`, `+233-auth-test-…`). These cannot be real accounts.
`src/scripts/cleanupTestAccounts.ts` removes them, dry-run by default.

**Group B — ambiguous, NOT deleted.** `src/services/ussd/ussdHandler.test.ts`
used to generate *structurally valid* numbers (`23320…`) and
`findOrCreateRiderByPhone` names every row it creates `USSD Rider`. Fixture
rows from those runs are therefore indistinguishable from genuine USSD riders —
including the three real shadow accounts found earlier. **Do not delete by
name.** Size the group with the inventory query and decide case by case; the
cleanup script deliberately refuses to touch them.

## Order of operations

1. Run the inventory query (read-only) and review it.
2. Run the cleanup dry-run, review the plan, then apply.
3. Re-run the phone-canonicalisation migration **on a Neon branch first**, then
   production.
