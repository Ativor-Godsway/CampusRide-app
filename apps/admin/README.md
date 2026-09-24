# @rida/admin

The CampusRide admin console: a small Vite + React SPA with two screens behind
one login.

- **Driver approvals** — every driver sitting at `isApproved = false`, with the
  info they submitted (name, phone, vehicle, plate, photo), and approve/reject
  buttons. A rejection requires a reason, which is stored on the audit row.
- **Rides** — a read-only oversight list, filterable by status and a date
  window.

It has no backend of its own. It authenticates against the same
`/auth/request-otp → /auth/verify-otp → /auth/login` chain the rider and driver
apps use, and is gated on `user.role === "ADMIN"` after login. The real
enforcement is server-side (`requireAdmin`); the client-side check exists only
so a non-admin gets an honest message instead of a wall of 403s.

## Running it locally

```bash
# 1. Start the API (separate terminal, from the repo root)
npm run dev:server

# 2. Point the admin app at it
cp apps/admin/.env.example apps/admin/.env   # defaults to http://localhost:3000

# 3. Start the admin app
npm run dev:admin                            # http://localhost:5173
```

Sign in with the phone number of a user who has been promoted with
`apps/server/src/scripts/seedAdmin.ts`. In development the OTP goes to the
dummy provider — read the code out of the server log.

## Building

```bash
npm run build:admin    # typechecks, then emits apps/admin/dist
```

`VITE_API_URL` is inlined into the bundle **at build time**, so pointing the app
at a different API means a rebuild, not just a restart.

## Notes

- The session (access token) lives in `sessionStorage`, not `localStorage`, and
  the refresh token is never persisted: this tool decides who is allowed to
  drive, so the session should not outlive the browser tab.
- In production the API refuses any browser origin not listed in
  `CORS_ALLOWED_ORIGINS` — the deployed admin origin must be on that list. See
  `DEPLOY.md → Admin app`.
