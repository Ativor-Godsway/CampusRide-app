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

**The fixtures predate the guard by a month.** Their phone numbers embed the
timestamp at which they were created:

| Fixture | Created |
| --- | --- |
| `+233-2a-test-1781866008245-34` | 2026-06-19 |
| `+233-auth-test-1780948084350-1` | 2026-06-08 |

Commit `f39c252` — *"split dev/test/prod databases with local Postgres test
runner"*, which introduced **both** `.env.test` **and** `assertNotProdDatabase`
— landed **2026-07-15**.

Before that commit there was no `.env.test` and no guard in
`src/test/setup.ts`. `npm test` is `vitest run`, which loads whatever
`config.ts` resolves — and with no env-specific file, that is the base `.env`,
**which points at `ep-ancient-butterfly`: production**. So the suite connected
to the live database and wrote fixtures there, with nothing in the way.

### The `ep-blue-union` red herring

An earlier version of this document blamed `.env.test` pointing at
`ep-blue-union`. That cannot be the cause: the fixtures are in
`ep-ancient-butterfly`. `ep-blue-union` was configured *later*, as a Neon test
target, and has since been commented out in favour of local Postgres. It is
unrelated to this incident, and is listed in `KNOWN_PROD_DB_HOSTS` only as a
precaution until someone confirms what it actually is.

The hosts each env file targets today:

| File | Host |
| --- | --- |
| `.env` | **was** `ep-ancient-butterfly` (production) — now repointed at the dev branch |
| `.env.development` | `ep-flat-rain-…` (Neon dev) |
| `.env.test` | `localhost:5432/rida_test`, with `ep-blue-union-…` commented out |

### Does `npm test` run `db:guard`?

**No.** `npm test` is `vitest run`. The `db:guard` script is only chained into
`db:migrate:test`, `db:seed:test` and `db:reset:*`. The suite's only protection
was a statement in `src/test/setup.ts` — one file, loaded via
`vitest.config.ts` → `setupFiles`. Remove it, reorder it, or reach the database
by any path that does not load it, and there is no check at all.

## The fix

### 1. The gate moved to the connection itself

`src/db/prisma.ts` is where every database connection in the server is created,
so `assertDatabaseAllowedForEnv` now runs there, as the client is constructed.
vitest, any `ts-node` script and the dev server all inherit it regardless of
entry point. **A test can no longer open a connection to a database it is not
allowed to touch, whatever the setup files say.**

Rules by environment:

| `NODE_ENV` | Allowed |
| --- | --- |
| `production` | anything — production connects to production |
| `test` | local Postgres, or a host named exactly in `ALLOW_TEST_DB_HOST` |
| anything else | anything **except** a known production host |

`src/index.ts` repeats the check at startup so a misconfigured dev server fails
with a clear first line rather than a stack trace from an import.

### 2. The guard itself fails closed

`assertNotProdDatabase` was a denylist naming one host. It is now an allowlist:
local is fine, any other host must be named in `ALLOW_TEST_DB_HOST`, a known
production host is refused even if named, and a missing or unparseable URL is
refused rather than assumed safe.

### 3. Deliberate production access, for the scripts that need it

`seedAdmin` and `cleanupTestAccounts` are *supposed* to touch production. They
opt in per command with `ALLOW_PRODUCTION_DB=1`, which prints a warning naming
the host. It is unreachable from `NODE_ENV=test` — a test can never unlock
production, whatever is exported in the shell.

### 4. `.env` no longer holds production credentials

The base `.env` — the fallback for anything that does not load a more specific
file, which is exactly what caused this — now points at the dev branch.
Production credentials live in Render. For a one-off against production, paste
the URL inline alongside `ALLOW_PRODUCTION_DB=1`.

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
