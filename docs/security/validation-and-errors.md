# Input validation, errors, logs and shutdown

What the server accepts, what it says when something goes wrong, what it
never writes to a log, and how it stops. Pre-launch hardening, Stage 4
(2026-10-15). Written for the owner and anyone changing the server.

## What a request may contain

Every route declares a JSON schema for its body, its URL parameters and,
for reads, its query string (`apps/server/src/http/schemas.ts`). A test
(`src/http/schemas.test.ts`) walks the real route table and fails if a route
has no schema, or a schema that is loose anywhere:

- **No unlisted fields.** Every object has `additionalProperties: false`.
  A field a route doesn't list is **dropped before the handler runs**, so an
  extra `role`, `isApproved` or `driverId` never reaches the code. Dropped,
  not refused: an older app that still sends a retired field keeps working.
- **Every string has a maximum length**: names 60, plates 20, phone numbers
  40, notes 1,000, tokens 2,048, search text 200 (the full list is `MAX` in
  `schemas.ts`).
- **Ids** are 1–64 letters, digits, `_` or `-`. **Coordinates** are real
  latitudes and longitudes. **Choices** (cancel reasons, ride statuses, push
  platform) must be one of the listed values. **Numbers** have a range.
  **Lists** have a maximum size.
- **Phone numbers** are length-checked by the schema, then read by the
  shared Ghana number parser in the handler (no pattern can express every
  spelling it accepts: [docs/phone-formats.md](../phone-formats.md)).
- **Types are not converted.** A body that sends `"stars": "5"` or
  `"name": 42` is refused rather than quietly turned into the right type
  (`src/http/validation.ts`). Query strings are always text, so `?limit=20`
  is still read as a number.

Sign-in is checked **before** the body is looked at: someone not signed in
gets 401, and a signed-in non-admin calling an admin route gets 403, whatever
they sent. Validation never tells a stranger anything about a route.

**Size limits:** a request body over **64 KB** gets 413 (the largest real
request is a few hundred bytes). A Socket.io message over **16 KB** closes
that connection (`src/http/serverOptions.ts`).

## What a client sees when something goes wrong

Every error has the same shape, and nothing internal in it:

```json
{ "error": "name must be at most 60 characters", "code": "INVALID_REQUEST", "requestId": "3f2c9a1e-…" }
```

| What happened | Status | `code` | `error` |
|---|---|---|---|
| Fails the route's schema | 400 | `INVALID_REQUEST` | The first problem, in plain words ("phone is required") |
| Broken JSON | 400 | `INVALID_JSON` | Short, fixed message |
| Body over 64 KB | 413 | `BODY_TOO_LARGE` | "That request is too large." |
| No such route | 404 | `NOT_FOUND` | "Not found." |
| A bug, a database error, a timeout | 500 | `INTERNAL_ERROR` | "Something went wrong on our side. Please try again." |

A 500 never carries a stack trace, a Prisma message or SQL, in any
environment. The full error goes to the log instead, under the same request
id (`src/http/errors.ts`).

Refusals a route makes itself ("You already have an active ride", "phone is
not a valid Ghanaian number") are unchanged: same status, same `error`, so
the apps behave exactly as before.

### Request ids: finding the log line for a user's error

Every response has an `X-Request-Id` header, and every error body has a
`requestId`. The server makes a fresh random id for each request and never
accepts one from the client. To investigate "the app said something went
wrong":

1. Get the request id (from the response, or a screenshot of an error body).
2. Render → the server → **Logs**, search for the id. The request's lines,
   including the full (scrubbed) error and stack, all carry `"reqId":"<id>"`.

## What never appears in a log

Every log line, from Fastify's request logger and from the background logger
(`src/lib/logger.ts`), passes through one scrubber
(`src/lib/redact.ts`). A careless `log.info({ phone, token })` added later
is masked, not leaked.

| In the log | Becomes |
|---|---|
| A Ghana number, any spelling (`+233548617146`, `0548617146`, `233…`) | `+233*****146` (enough to recognise, not to dial) |
| A login token, verification token or any JWT | `[jwt]` |
| A refresh token, tracking token (32+ hex characters) | `[hex]` |
| An Expo push token | `ExponentPushToken[…]` |
| A tracking link's path | `/track/[token]` |
| Credentials inside a URL (`postgresql://user:pass@host`) | `postgresql://[credentials]@host` |
| Any field named like a secret (`authorization`, `token`, `refreshToken`, `pushToken`, `password`, `otp`, `otpCode`, `secret`, `apiKey`, …) | `[redacted]` |

This applies to messages, structured fields (nested), request URLs and error
messages and stacks. Request headers and bodies are never logged at all.

**One exception, by design:** on a developer's machine with the dummy SMS
provider (`OTP_PROVIDER=dummy`, `NODE_ENV=development`), the login code is
printed so a local sign-in can be completed. Production refuses to start
with that provider ([DEPLOY.md](../../DEPLOY.md#login-codes-in-development)).

`LOG_LEVEL` (default `info`) sets how much is logged; leave it unset on
Render.

## When something crashes

An error nothing caught (an unhandled promise rejection or an uncaught
exception) is logged, scrubbed, as `"event":"fatal"`, and the server shuts
down as below and exits with code 1. Render then starts a fresh one. A
process that has hit one can't be trusted to keep running correctly
(`src/lib/fatal.ts`). Each is also reported to Sentry
([monitoring.md](monitoring.md)).

A failure during startup (a missing setting, an unreachable database) is
logged, scrubbed, as "Failed to start server", and exits with code 1.

## Shutting down on a deploy

Render sends `SIGTERM` to the old server when a new one is ready
(`src/lib/shutdown.ts`):

1. The ride timeout sweep and push receipt check stop.
2. The server stops accepting new requests, and **requests already in
   progress finish**: a driver's "picked up" isn't cut off halfway. Idle
   keep-alive connections are closed so they don't hold the server open.
3. Every Socket.io connection is closed, so the apps reconnect to the new
   server straight away.
4. The database connections close.
5. The process exits with code 0.

If anything hangs, it exits anyway after 20 seconds, inside Render's
allowance. In the logs a deploy shows the old server's `"event":"shutdown"`
then `"event":"shutdown_complete"`.

## Adding a route

- Give it `schema: …` built from the helpers in `src/http/schemas.ts`:
  `object({ … }, ["required", "fields"])`, `id`, `phone`,
  `text(MAX.name)`, `oneOf([...])`, `integer(min, max)`, `latitude`,
  `longitude`; `idParams` for `/:id`; `noInput` for a route that takes
  nothing.
- A signed-in route uses `onRequest: requireAuth` (an admin route,
  `onRequest: [requireAuth, adminOnly]`), so sign-in is checked before
  validation. A route whose body may be missing adds
  `preValidation: bodyOptional`.
- Call `useRequestValidation(app)` at the top of a new register function.
- `src/http/schemas.test.ts` fails until the schema is complete.

## Found along the way, not changed here

- The demo site's login-code routes (`/demo/otp/*`) count sends per IP from
  the leftmost `X-Forwarded-For` entry, which a client can set itself. They
  have their own per-phone and global caps, so the exposure is SMS cost on the
  demo only. Fix: use `request.ip` (Stage 2's trusted-proxy handling), as
  every other route does. A separate small change.
