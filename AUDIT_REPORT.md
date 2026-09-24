# CampusRide — Engineering Audit

**Date:** 2026-09-22 · **Commit audited:** `97456a6` (branch `main`, with uncommitted modifications to 7 files)
**Method:** Source-of-truth is the code. `ROADMAP.md` / `DEPLOY.md` claims were verified against implementation; discrepancies are flagged inline.

---

## 1. Executive Summary

CampusRide is a **zone-based campus ride-hailing system for Ghana**, built as an npm-workspaces monorepo: two Expo/React Native apps (rider, driver), a Fastify + Prisma + PostgreSQL backend, and two shared packages. It also has a USSD channel for feature-phone riders.

**Overall completion: roughly 70% of a v1 product — but the last 30% is almost entirely the part that makes an app shippable.**

The backend is genuinely good work. The ride lifecycle is a real state machine with a real atomic dispatch/claim, real per-passenger shared-ride assembly, integer-pesewas money handling, a real Moolre MoMo integration with webhook secret verification and DB-level idempotency, layered rate limiting, and **345 passing automated tests** (86 in `packages/shared`, 259 + 1 skipped in `apps/server`). Authorization is consistently enforced: every non-public route carries `requireAuth`, plus a role gate and a per-resource ownership check. This is materially better than typical code at this stage.

The mobile apps tell a different story. The **core ride flow works end to end**, but everything around it is a "coming soon" alert: profile editing, payment methods, notification settings, help/support, wallet, safety. There are **zero mobile tests, zero e2e tests, no linting, no CI, no crash reporting, and no app icons, splash screens, or EAS build config**.

**The five biggest risks:**

1. **Store submission is blocked on basics, not features.** No app icon, no splash screen, no EAS config, no privacy policy, no account-deletion path (both Apple and Google *require* in-app account deletion when you allow account creation), and `app.json` still hardcodes `http://localhost:3000` as the fallback server URL.
2. **Anyone can self-register as a DRIVER, and nothing in the product can approve them.** `isApproved` is correctly enforced at every gate (`driver.ts:147,346,449`, `dispatch.ts:32`) — but there is **no admin route, no admin app, and no approval workflow anywhere in the codebase**. Approving a driver today means hand-editing a production database row. There are also no background checks, no document upload, and no licence/insurance capture.
3. **Payment is voluntary.** MoMo collection is only ever triggered by the rider tapping "Pay" *after* the ride completes (`rides.ts:305`). Nothing charges them, nothing chases them, and CASH rides only create a commission ledger row with no collection mechanism. This is a revenue-model gap, not just a code gap.
4. **44 npm vulnerabilities (2 critical, 26 high)**, including a production-path `ws` DoS reachable through Socket.io and an `axios` advisory cluster affecting both mobile apps.
5. **`POST /ussd/callback` is completely unauthenticated with no shared secret** (`ussd.ts:36-41`, acknowledged in the code comment). Anyone who finds the URL can create rides and auto-provision rider accounts for arbitrary phone numbers.

**Verdict: not close to launchable, but closer than it looks.** The hard part — a correct, tested, concurrency-safe ride and payment engine — is done. What remains is unglamorous and largely mechanical: admin tooling, store assets, account lifecycle, and the operational layer (CI, monitoring, dependency hygiene). Realistically **6–10 focused weeks to a submittable build**, with driver approval and account deletion on the critical path.

### Doc vs. code discrepancies

| Claim | Reality |
|---|---|
| `ROADMAP.md:~85` — "apps/server: **206/206 pass**, 20 test files" | Actually **26 test files, 259 passed + 1 skipped**. Stale, understated. |
| `ROADMAP.md:~85` — "packages/shared: **89/89 pass**" | Actually **86 pass** (51 pricing claimed vs 48 actual). Stale. |
| `ROADMAP.md` — Phase 4c "Wire payments into ride lifecycle ✅ COMPLETE" | **Not wired.** `initiateCollection` has exactly one non-test call site: the rider-initiated route `rides.ts:349`. `departRide` never touches payments, and the test that would have proven it is `it.skip`-ped (`assembly.test.ts:469`). |
| `ROADMAP.md` — Phase 6a "✅ COMPLETE — pending two-device verification" | Code matches, but note nothing in the repo has ever been verified on a real device pair; every "pending device verification" caveat is still outstanding. |
| `DEPLOY.md` | Accurate. Connection strings are placeholders only — confirmed clean across all 93 commits. |
| `render.yaml:52` — `OTP_PROVIDER: dummy` | Accurate but alarming as a *production* default: the live service logs OTPs to the console instead of sending SMS unless overridden in the dashboard. |

---

## 2. Feature Inventory

Legend: ✅ Complete · 🟡 Partial · 🔴 Not started · ⚠️ Broken · 🗑️ Dead/orphaned

### Authentication & Onboarding

| Feature | What it does | Where | % | Status | Missing | Recommendation |
|---|---|---|---|---|---|---|
| Phone + OTP auth (no passwords) | 6-digit SHA-256-hashed OTP, 5 min TTL, verification-token exchange | `services/auth/otp.ts`, `authService.ts`, `routes/auth.ts` | 95% | ✅ | — | Keep as-is |
| Access/refresh tokens | 30 min JWT access, 30 day hashed refresh, revocable | `services/auth/tokens.ts`, `constants.ts:28-40` | 95% | ✅ | No refresh-token rotation on use | Keep as-is |
| Rider signup/login | Full flow incl. role selection | `rider/app/auth/*`, `mobile-shared/src/auth/screens/` | 95% | ✅ | — | Keep as-is |
| Driver signup/login | Same flow, `role: "DRIVER"` | `driver/app/auth/*` | 90% | 🟡 | Role is **self-declared and unverified** (`auth.ts:30`) | Finish before launch |
| Driver vehicle onboarding | Make/model/colour/plate capture | `driver/app/onboarding.tsx` | 80% | 🟡 | No licence, insurance, or ID document capture | Finish before launch |
| Driver photo upload | Unsigned client-direct Cloudinary upload | `mobile-shared/src/config/cloudinary.ts` | 85% | 🟡 | Unsigned preset — anyone can upload to your Cloudinary (`cloudinary.ts:9` TODO) | Finish before launch |
| Driver approval workflow | `isApproved` gates going online, claiming, eligibility | `driver.ts:147,346,449`, `dispatch.ts:32` | 40% | 🟡 | Gate exists; **nothing can flip the flag**. No admin route anywhere | Must fix before launch |
| Password reset | — | — | 0% | 🔴 | N/A by design (OTP-only auth) | Cut for v1 |
| Social login | — | — | 0% | 🔴 | Entirely absent | Cut for v1 |
| Student ID / eligibility verification | — | — | 0% | 🔴 | **Entirely absent.** Nothing ties a user to a university | Needs a product decision |
| Role-mismatch guard | Blocks a rider signing into the driver app | `mobile-shared/src/design/components/RoleMismatchScreen.tsx` | 100% | ✅ | — | Keep as-is |

### Rider Experience

| Feature | What it does | Where | % | Status | Missing | Recommendation |
|---|---|---|---|---|---|---|
| Home / service grid | Greeting, Rides tile, recent destinations | `rider/app/(tabs)/index.tsx` | 90% | ✅ | Food/Courier tiles are `Alert` stubs (`index.tsx:39`) | Keep as-is |
| Pickup/dropoff selection | Zone-name autocomplete + GPS nearest-zone prefill | `rider/app/ride/location.tsx` | 90% | ✅ | Zone-name-only; no free-text addresses or map pin-drop | Keep as-is |
| Fare estimate | Flat pricing from shared pure functions | `packages/shared/src/pricing/pricing.ts` | 100% | ✅ | — | Keep as-is |
| Ride request (LONE/SHARED) | Creates REQUESTED ride, triggers broadcast | `routes/rides.ts:96`, `services/ride/createRide.ts` | 95% | ✅ | — | Keep as-is |
| Live ride tracking | Socket.io driver GPS → map, with polling fallback | `mobile-shared/src/rides/useRideTracking.ts`, `maps/CampusMapView.tsx` | 85% | ✅ | No ETA calculation anywhere | Keep as-is |
| Full ride lifecycle UI | Searching → no-driver → matched → in-progress → completed, one screen | `rider/app/ride/type.tsx` (1,357 lines) | 90% | 🟡 | Single 1,357-line file; one leftover `console.log` at `type.tsx:934` | Keep as-is |
| Rider decision on timeout | KEEP_WAITING / SWITCH_TO_LONE / CANCEL after 90s | `routes/rides.ts:219`, `services/ride/riderDecision.ts` | 95% | ✅ | — | Keep as-is |
| Ride cancellation | Blocked once IN_PROGRESS | `routes/rides.ts:264` | 95% | ✅ | No cancellation fee logic | Keep as-is |
| Ride history | Last 50 rides with status badges | `rider/app/(tabs)/rides.tsx`, `routes/rides.ts:156` | 90% | ✅ | Hard-capped at 50, no pagination | Keep as-is |
| Favourites / saved locations | — | — | 0% | 🔴 | Entirely absent | Cut for v1 |
| Scheduled / future rides | — | — | 0% | 🔴 | Entirely absent | Cut for v1 |

### Driver Experience

| Feature | What it does | Where | % | Status | Missing | Recommendation |
|---|---|---|---|---|---|---|
| Online/offline + zone | Availability toggle gated on approval + complete profile | `routes/driver.ts:129` | 95% | ✅ | — | Keep as-is |
| Request list | Sectioned, filterable, best-match badge, accept | `driver/app/(tabs)/index.tsx` (1,210 lines) | 90% | ✅ | Largest file in the repo; needs decomposition | Keep as-is |
| Accept/claim ride | Atomic conditional UPDATE, first-claim-wins | `services/ride/dispatch.ts:72+`, `routes/driver.ts:339` | 100% | ✅ | — | Keep as-is |
| Explicit reject | — | — | 0% | 🔴 | Drivers can only ignore, never decline | Can ship without |
| Fill-your-car (shared assembly) | Ranked fill suggestions, add passenger to claimed car | `routes/driver.ts:547,645`, `services/ride/assembly.ts`, `ranking.ts` | 95% | ✅ | — | Keep as-is |
| Per-passenger lifecycle | Independent arrived/pickup/dropoff/cancel per passenger | `routes/driver.ts:755-980` | 95% | ✅ | — | Keep as-is |
| Active ride screen | Step-driven navigate→arrived→depart→complete | `driver/app/ride/[id].tsx` | 90% | ✅ | — | Keep as-is |
| Turn-by-turn navigation | — | — | 0% | 🔴 | **No maps hand-off at all** — no `Linking.openURL` to Google/Apple Maps | Finish before launch |
| Earnings dashboard | Completed rides + gross total | `routes/driver.ts:224`, `driver/app/(tabs)/rides.tsx` | 75% | 🟡 | Gross only — no commission owed, no net, no date filtering | Finish before launch |
| Payout requests | — | — | 0% | 🔴 | Disbursement is automatic per-ride; driver cannot request or view payouts | Needs a product decision |
| Driver payout network choice | Hardcoded to MTN | `routes/webhooks.ts:27-30` | 20% | 🟡 | Non-MTN drivers get payouts sent to the wrong network | Must fix before launch |
| Driver profile edit | Name + vehicle + photo | `routes/driver.ts:281`, `driver/app/(tabs)/account.tsx` | 90% | ✅ | — | Keep as-is |

### Matching / Dispatch

| Feature | What it does | Where | % | Status | Missing | Recommendation |
|---|---|---|---|---|---|---|
| Eligible-driver selection | Online + approved + in pickup zone or 1-hop adjacent | `services/ride/dispatch.ts:13-35` | 100% | ✅ | Zone-adjacency graph, not true geo-distance | Keep as-is |
| Broadcast to drivers | Socket.io fan-out to per-driver rooms | `dispatch.ts:41-71`, `rideSocket.ts:emitDriverBroadcast` | 100% | ✅ | — | Keep as-is |
| Atomic claim | Conditional UPDATE, race-safe | `dispatch.ts:72+` | 100% | ✅ | — | Keep as-is |
| Ranking / best-fit | Scored combinability for shared fills | `packages/shared/src/ranking/{ranking,bestFit}.ts` | 100% | ✅ | — | Keep as-is |
| Dispatch timeouts | 90s broadcast + 90s decision grace, swept every 30s | `services/ride/timeouts.ts`, `index.ts:22` | 90% | 🟡 | `setInterval` in-process — won't survive multi-instance scaling | Should fix before launch |
| State machine | Explicit transition tables, ride + passenger | `services/ride/stateMachine.ts` | 100% | ✅ | — | Keep as-is |

**This is a real algorithm, not a placeholder.**

### Real-time

| Feature | What it does | Where | % | Status | Missing | Recommendation |
|---|---|---|---|---|---|---|
| Socket.io server | JWT handshake auth, per-ride/driver/rider rooms | `realtime/rideSocket.ts` | 95% | ✅ | — | Keep as-is |
| Live driver location | Driver GPS → ride room, authorized per ride | `rideSocket.ts:89-101,126-137` | 95% | ✅ | Ephemeral only, never persisted (good for privacy) | Keep as-is |
| Socket reconnect + polling fallback | | `mobile-shared/src/realtime/socket.ts`, `rides/useRideTracking.ts` | 90% | ✅ | 3 `console.log` calls in `socket.ts` | Keep as-is |
| ETA updates | — | — | 0% | 🔴 | Entirely absent | Should fix before launch |
| Rider↔driver chat or call | — | — | 0% | 🔴 | **Entirely absent.** No masked calling, no in-app messaging | Finish before launch |

### Payments

| Feature | What it does | Where | % | Status | Missing | Recommendation |
|---|---|---|---|---|---|---|
| Moolre MoMo collection | Real API, MTN/Telecel/AT, OTP sub-flow | `services/payment/MoolrePaymentService.ts`, `paymentFlow.ts` | 90% | ✅ | — | Keep as-is |
| Payment idempotency | Deterministic `externalRef` + DB `@unique` | `schema.prisma:Payment.providerRef`, `paymentFlow.ts:150` | 100% | ✅ | — | Keep as-is |
| Webhook handling | Secret-verified, atomic collect→disburse | `routes/webhooks.ts`, `paymentFlow.ts:399+` | 90% | 🟡 | Non-constant-time secret compare (`paymentFlow.ts:266`); logs full body (`webhooks.ts:46`) | Must fix before launch |
| Driver disbursement | Auto per-rider payout on collection success | `paymentFlow.ts:399+` | 85% | 🟡 | Channel hardcoded to MTN | Must fix before launch |
| Payment collection trigger | **Rider-initiated only, post-completion** | `routes/rides.ts:305` | 50% | 🟡 | Nothing compels or chases payment. Contradicts ROADMAP "4c COMPLETE" | Needs a product decision |
| CASH commission ledger | 15% platform commission row per CASH ride | `routes/driver.ts:63-77`, `schema.prisma:CommissionLedger` | 60% | 🟡 | Records debt; **no mechanism to ever collect it** | Needs a product decision |
| Fare locking | Locked at join, ratchets down with occupancy, frozen at depart | `services/ride/lockedFare.ts` | 100% | ✅ | — | Keep as-is |
| Receipts | In-app fare summary only | `rider/app/ride/type.tsx:875+` | 40% | 🟡 | No emailed/downloadable receipt, no receipt history | Can ship without |
| Wallet / balance | — | `rider/app/(tabs)/account.tsx:12` | 0% | 🔴 | UI tile only → "coming soon" alert | Cut for v1 |
| Refunds | `REFUND` enum exists | `schema.prisma:PaymentType` | 5% | 🔴 | Enum value only; zero implementation | Finish before launch |
| Promo codes / referrals | — | — | 0% | 🔴 | Entirely absent | Cut for v1 |
| Paystack provider | Interface implemented, every method throws | `services/payment/PaystackPaymentService.ts:41-53` | 10% | 🗑️ | Dead — Moolre is the active provider | Cut for v1 (delete) |

### Safety

| Feature | Where | % | Status | Recommendation |
|---|---|---|---|---|
| Rider→driver ratings (1-5 + comment, upsertable) | `routes/ratings.ts`, `rider/app/ride/type.tsx:799` | 90% ✅ | — | Keep as-is |
| Driver→rider ratings | — | 0% 🔴 | Schema supports it (`Rating` is directional); **no route, no UI** | Should fix before launch |
| SOS / panic button | `rider/app/(tabs)/account.tsx:13` | 0% 🔴 | "Safety" tile → "coming soon" alert | **Finish before launch** |
| Trip sharing with contacts | — | 0% 🔴 | Entirely absent | Finish before launch |
| Driver background checks | — | 0% 🔴 | Entirely absent | Needs a product decision |
| Emergency contacts | — | 0% 🔴 | Entirely absent | Should fix before launch |

**Safety is the weakest category in the product.** For a campus ride-hailing app — largely young users, often at night — shipping with zero safety features is the finding I'd push back on hardest.

### Notifications

| Feature | Where | % | Status | Recommendation |
|---|---|---|---|---|
| Push notifications | — | 0% 🔴 | **Entirely absent** — `expo-notifications` is not even a dependency. ROADMAP lists it as explicitly deferred | Finish before launch |
| In-app realtime events | `realtime/rideSocket.ts` | 90% ✅ | Works only while the app is foregrounded | Keep as-is |
| SMS (USSD riders) | `services/sms/{sendSms,notifyUssdRiders}.ts` | 85% 🟡 | Only fires for `source: "USSD"` rides | Keep as-is |
| OTP SMS | `services/otp/MoolreOtpService.ts` | 90% ✅ | — | Keep as-is |
| Email | — | 0% 🔴 | No email anywhere; `User` has no email field | Cut for v1 |
| Notification preferences | `rider/app/(tabs)/account.tsx:81` | 0% 🔴 | "Coming soon" alert | Can ship without |

**A ride-hailing app with no push notifications means a driver misses every request unless the app is open and on-screen.** This is a functional blocker, not a nice-to-have.

### Admin / Backoffice

| Feature | Where | % | Status | Recommendation |
|---|---|---|---|---|
| Admin app / panel | — | 0% 🔴 | **Does not exist.** No fourth workspace, no web app | Must fix before launch |
| Admin API routes | — | 0% 🔴 | Zero routes check `role === "ADMIN"` | Must fix before launch |
| `ADMIN` role | `schema.prisma:UserRole` | 5% 🗑️ | Enum value exists and is **completely unused** — not even assignable at signup (`auth.ts:30`) | Must fix before launch |
| Driver approval UI | — | 0% 🔴 | Manual DB edit only | Must fix before launch |
| Ride monitoring / dispute handling / analytics | — | 0% 🔴 | Entirely absent | Should fix before launch |

### Campus-Specific

| Feature | Where | % | Status | Recommendation |
|---|---|---|---|---|
| Campus zones (15 seeded) | `prisma/seed.ts`, `routes/zones.ts` | 95% ✅ | Fixed pickup points, quadrant-tagged | Keep as-is |
| Zone adjacency graph | `schema.prisma:ZoneAdjacency` | 95% ✅ | Drives dispatch eligibility | Keep as-is |
| Nearest-zone from GPS | `packages/shared/src/geo/distance.ts` | 100% ✅ | Haversine, tested | Keep as-is |
| Geofencing to campus | — | 0% 🔴 | **No boundary enforcement.** Nothing prevents use off-campus | Needs a product decision |
| Student eligibility check | — | 0% 🔴 | Entirely absent | Needs a product decision |

### USSD Channel

| Feature | Where | % | Status | Recommendation |
|---|---|---|---|---|
| USSD menu + session handling | `services/ussd/ussdHandler.ts`, `session.ts`, `routes/ussd.ts` | 85% 🟡 | **In-memory sessions** (`session.ts`) — lost on restart, breaks on >1 instance | Should fix before launch |
| Auto rider provisioning by phone | `services/ussd/findOrCreateRiderByPhone.ts` | 85% 🟡 | Creates accounts with **no verification** on an unauthenticated endpoint | Must fix before launch |
| SMS status updates to USSD riders | `services/sms/notifyUssdRiders.ts` | 85% ✅ | — | Keep as-is |

A genuinely differentiated feature and a sensible bet for the Ghanaian market — but the security posture doesn't match the rest of the backend.

### Settings, Account & Support

| Feature | Where | % | Status | Recommendation |
|---|---|---|---|---|
| Rider profile edit | `rider/app/(tabs)/account.tsx:72` | 0% 🔴 | "Coming soon" alert — but the backend route exists for drivers | Finish before launch |
| **Delete account** | — | 0% 🔴 | **Absent everywhere.** No UI, no route. Store-mandated | **Must fix before launch** |
| Payment methods screen | `account.tsx:78` | 0% 🔴 | "Coming soon" alert | Can ship without |
| Language / locale | — | 0% 🔴 | English hardcoded throughout | Cut for v1 |
| Help centre / FAQ / support chat | `account.tsx:90` | 0% 🔴 | "Coming soon" alert. **No support channel of any kind** | Finish before launch |
| Terms & privacy policy | `mobile-shared/src/auth/screens/PhoneScreen.tsx:63` | 5% 🔴 | Text claims the user agrees to them; **neither document exists and neither is linked** | **Must fix before launch** |
| Logout | `account.tsx:20` | 100% ✅ | — | Keep as-is |

### Dead / Orphaned Code

| Item | Where | Recommendation |
|---|---|---|
| `PaystackPaymentService` | `services/payment/PaystackPaymentService.ts` | Delete — all 4 methods throw |
| `mockDriver` simulator | `dev/mockDriver.ts`, gated by `ENABLE_MOCK_DRIVER` | Keep (dev-only, correctly gated, off in `render.yaml:58`) |
| `MnotifyOtpService` | `services/otp/MnotifyOtpService.ts` | Keep as fallback, or delete — Moolre is active |
| `ADMIN` enum value | `schema.prisma:UserRole` | Unused; becomes live once admin work starts |
| `MapboxStaticMap` | `mobile-shared/src/maps/MapboxStaticMap.tsx` | Superseded by `CampusMapView` per ROADMAP 5f; verify then delete |
| 4 Moolre test scripts | `server/src/scripts/*.ts` | Keep (manual integration tools), exclude from prod build |
| `apps/server/dist/` | committed build output dir present on disk | Gitignored — confirm it isn't deployed stale |

### Literal Grep Pass

**TODO / FIXME / HACK / XXX — 19 total matches, but only 3 are real:**

| Location | Content |
|---|---|
| `mobile-shared/src/config/cloudinary.ts:9` | `TODO(post-buildathon)` — move to signed server-side upload |
| `services/payment/paymentFlow.ts:339` | `TODO(3c)` — `AWAITING_OTP` buckets as `PENDING` in summaries |
| `rider/app/ride/type.tsx:898` | `TODO` reference in a comment |

The other 16 are false positives — `XXX` inside the phone-number format string `+233XXXXXXXXX` across `lib/phone.ts`, the 4 script files, and `MoolreSmsService.ts`. **No `FIXME` or `HACK` anywhere.**

**"Not implemented" / stubs:** 4 in `PaystackPaymentService.ts:41,45,49,53`; 1 acknowledged non-implementation at `routes/ussd.ts:41` (Moolre gateway IP allowlist).

**"Coming soon" alerts (8 user-facing dead ends):** `rider/app/(tabs)/index.tsx:39` (Food, Courier); `rider/app/(tabs)/account.tsx:29` (Help, Wallet, Safety, Inbox, Edit profile, Payment methods, Notifications, Help & support); `driver/app/onboarding.tsx:126` ("Photo upload coming soon" — **stale**, upload works in `driver/app/(tabs)/account.tsx:48`).

**console.* — 92 total, of which 71 are in dev scripts and seeds (fine). Production-path concerns:**

| File:line | Issue |
|---|---|
| `routes/webhooks.ts:46` | `console.log` of the **entire webhook body — including the shared secret and payer phone** |
| `services/payment/MoolrePaymentService.ts:217` | Logs full Moolre response `data` on every call |
| `services/otp/DummyOtpService.ts:5` | **Logs the plaintext OTP.** Active whenever `OTP_PROVIDER=dummy` — which is `render.yaml`'s production default |
| `services/sms/sendSms.ts:15` | Logs recipient phone + message body when SMS is unconfigured |
| `rider/app/ride/type.tsx:934` | `[OTP DEBUG]` log of the payment-initiation response |
| `mobile-shared/src/realtime/socket.ts` | 3 connection-lifecycle logs |

No hardcoded test credentials found. `mockDriver.ts` uses `isApproved: true` but is correctly flag-gated.

---

## 3. Security Findings

Mapped to OWASP API Top 10 (API) and Mobile Top 10 (M).

### CRITICAL

**C-1 · No admin capability exists to approve drivers — approval is a manual production DB edit** · *API5: Broken Function Level Authorization*
`isApproved` is enforced correctly at all four gates, but no route, app, or tool can set it. Operating this means giving someone direct write access to the production Postgres instance — unaudited, unauthenticated, and unrecoverable if misused. Combined with self-declared `role` at signup (`routes/auth.ts:30`), the only thing between an arbitrary stranger and driving for you is a manual DB write.
**Fix:** Build authenticated `ADMIN`-gated routes (`GET /admin/drivers/pending`, `POST /admin/drivers/:id/approve|reject`) with a `requireAdmin` preHandler mirroring `requireDriver` (`driver.ts:39`), an audit-log table recording actor/timestamp/reason, and a minimal admin UI. Seed the first admin via a one-off script, never via a self-signup path.

**C-2 · `POST /ussd/callback` is unauthenticated with no signature or shared secret** · *API2: Broken Authentication* · `routes/ussd.ts:36-41`
Explicitly acknowledged in the code. Anyone who discovers the URL can drive the USSD state machine, create REQUESTED rides at will, and auto-provision rider accounts for **any phone number** via `findOrCreateRiderByPhone.ts` — no verification. The only control is a 60/min per-IP rate limit that keys on Moolre's single gateway IP, so one attacker consumes the budget for all real USSD traffic.
**Fix:** Add a Moolre gateway IP allowlist (already identified as the intended fix in the same comment) as a preHandler. Request a shared secret or signature from Moolre and verify it as `webhooks.ts` does. Add per-msisdn rate limiting so one number can't spam ride creation.

### HIGH

**H-1 · 44 dependency vulnerabilities — 2 critical, 26 high** · *API6 / M2* · `npm audit`
Production-reachable: **`ws` ≤8.20.1** memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p) pulled in by `socket.io`/`engine.io` — directly reachable on your live WebSocket endpoint; **`fastify` ≤5.12.0** (body-validation bypass via Content-Type tab; `request.protocol`/`host` spoofable via `X-Forwarded-Proto`/`Host` — **relevant because `trustProxy: true` is on**, `index.ts:31`); **`socket.io-parser`** zero-attachment memory exhaustion; **`find-my-way`** HTTP/2 DDoS; **`fast-uri`** SSRF/host-confusion cluster; **`undici`** header-injection cluster; **`axios` 1.0.0–1.17.0** prototype-pollution and DoS cluster (both mobile apps). Critical `tar` and `vitest` are dev/build-path only.
**Fix:** `npm audit fix` for the non-breaking set, then deliberately upgrade `socket.io`, `fastify`, and `axios` and re-run the suite. Add `npm audit --audit-level=high` to CI as a gate.

**H-2 · Webhook handler logs the full payload including the shared secret** · *API8 / API3* · `routes/webhooks.ts:46`
`console.log("[MOOLRE WEBHOOK HIT]", JSON.stringify(request.body))` writes `MOOLRE_WEBHOOK_SECRET` and the payer's phone number into Render's logs in plaintext on every webhook. Anyone with log access can forge "paid" callbacks and trigger disbursements. `MoolrePaymentService.ts:217` leaks response data similarly.
**Fix:** Delete the line or redact to `externalref` + `txstatus` only. Audit and rotate `MOOLRE_WEBHOOK_SECRET` — assume it is already exposed in retained logs.

**H-3 · Webhook secret comparison is not constant-time** · *API2* · `services/payment/paymentFlow.ts:266`
`payload.secret === expectedSecret` on a value that authorizes money movement is timing-attack-observable.
**Fix:** `crypto.timingSafeEqual` on equal-length buffers, with an explicit length pre-check.

**H-4 · `OTP_PROVIDER=dummy` is the committed production default, and Dummy logs plaintext OTPs** · *API2* · `render.yaml:52`, `services/otp/DummyOtpService.ts:5`
As configured, the live service never sends real SMS and prints every OTP to the console. Anyone with Render log access can authenticate as any user. `services/active.ts` also **silently falls back to Dummy** if Moolre prerequisites aren't met — so a missing `MOOLRE_VAS_KEY` degrades production auth to "OTPs in the logs" with no alarm.
**Fix:** Change the `render.yaml` default to `moolre`. Make the server **refuse to boot** with `DummyOtpService` when `NODE_ENV=production`. Remove the `console.log` from `DummyOtpService`.

**H-5 · No in-app account deletion** · *Privacy / store policy* · absent repo-wide
Both Apple (Guideline 5.1.1(v)) and Google Play **require** an in-app deletion path when accounts can be created. This is an automatic rejection, and independently a GDPR-style erasure gap. Note `Ride.riderId` is `onDelete: Restrict`, so deletion needs a real anonymization design, not a cascade.
**Fix:** Add `DELETE /me` that anonymizes `User.name`/`phone` and revokes all refresh tokens while preserving ride and financial records for accounting. Surface it in both apps' account tabs with confirmation. Publish a retention policy alongside.

**H-6 · Unsigned Cloudinary upload preset is public in the app bundle** · *M1/M9* · `mobile-shared/src/config/cloudinary.ts`, `driver/.env`
`EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME=dkjaiqg5x` / `UPLOAD_PRESET=CampusRide` are inlined into every shipped bundle and trivially extracted. Anyone can upload unlimited arbitrary content to your Cloudinary account — a quota-exhaustion and illegal-content-hosting risk. Acknowledged as a deliberate buildathon shortcut.
**Fix:** Proxy uploads through the server, which signs with the Cloudinary API secret and enforces per-user rate limits, size caps, and MIME validation.

**H-7 · No crash reporting or monitoring of any kind** · *Operational*
No Sentry, Crashlytics, or APM in any workspace. A production crash or a failed disbursement is invisible unless a user reports it.
**Fix:** Add Sentry to both Expo apps and the Fastify server before any real traffic. Alert on webhook failures and disbursement errors specifically.

### MEDIUM

**M-1 · Driver payout network hardcoded to MTN** · `routes/webhooks.ts:27-30`
Honestly documented, but in production a Telecel or AT driver has their earnings pushed to an MTN wallet on their number — misdirected or failed payouts with no recovery path. **Fix:** add `payoutChannel` + `payoutPhone` to `Driver`, capture during onboarding, validate via Moolre's name-validation endpoint.

**M-2 · CORS reflects any origin when `DEMO_OTP_CORS_ORIGINS` is unset** · *API8* · `index.ts:48-53`, `render.yaml:68` (`sync: false`, likely unset)
`origin: true` reflects arbitrary origins across the whole API, not just demo routes. Native apps are unaffected, but any browser page can call your API with credentials. **Fix:** default to an explicit allowlist; reflect-any only when `NODE_ENV !== "production"`.

**M-3 · Socket.io CORS is `origin: "*"`** · *API8* · `index.ts:105`
Unconditional, regardless of the HTTP CORS allowlist. **Fix:** apply the same allowlist.

**M-4 · No token revocation on access tokens; no refresh rotation** · *API2* · `services/auth/tokens.ts`
A stolen 30-min access token is usable until expiry with no way to kill it. Refresh tokens are stored hashed and revocable (good) but are not rotated on use, so a stolen refresh token stays valid for 30 days undetected. **Fix:** rotate refresh tokens on every use and detect reuse of a consumed token as theft.

**M-5 · `GET /me` returns the full `User` + `Driver` record** · *API3: Excessive Data Exposure* · `routes/auth.ts:206`
Returns whatever columns exist now and whatever is added later — a schema change silently widens the response. Same pattern at `GET /rides/mine` (`rides.ts:156`) and `GET /rides/:id`, which return full Prisma models. **Fix:** explicit `select` clauses or response schemas on every route. Fastify response schemas would enforce this globally.

**M-6 · No request body size limits or response schema validation** · *API4* · `index.ts`
Fastify's 1MB default applies, but no per-route limits and no schema validation. Validation is hand-rolled type guards — correct and consistent, but unenforced by the framework. **Fix:** adopt Fastify JSON Schema (or Zod via a type provider) for body and response validation.

**M-7 · In-process `setInterval` timeout sweeper and in-memory USSD sessions block horizontal scaling** · `index.ts:22,139`, `services/ussd/session.ts`
Two instances run duplicate sweeps; USSD sessions vanish on restart and break behind a load balancer. **Fix:** move sessions to Redis or Postgres; move the sweeper to a single worker or a locked job.

**M-8 · No ride-level abuse protection beyond per-IP rate limits** · *API4* · `config.ts:60`
`RATE_LIMIT_RIDE_CREATE=20/15min` is per IP. `ActiveRideExistsError` limits concurrent rides per rider (good), but there's no per-account cap on serial request/cancel cycles. **Fix:** add per-user rate limiting and a cancellation-abuse counter.

**M-9 · `trustProxy: true` is unconditional** · *API8* · `index.ts:31`
Correct on Render, but combined with the `fastify` advisory in H-1, `X-Forwarded-For` can be spoofed to defeat every per-IP rate limit if the app is ever reachable without the proxy in front. **Fix:** upgrade Fastify and set `trustProxy` to a specific hop count or CIDR.

**M-10 · No deep-link validation** · *M4* · `rider/app.json:8`, `driver/app.json:8`
Both apps register custom schemes (`campusride-rider`, `campusride-driver`) via `expo-router`. Nothing validates inbound links, and any app can claim the same scheme. Currently low impact since no sensitive flow is deep-linkable — but that changes the moment one is. **Fix:** validate and allowlist inbound routes; prefer verified App Links / Universal Links.

### LOW

**L-1 · SHA-256 for OTP and refresh tokens.** `services/auth/hash.ts` — defensible and well-reasoned in the comment (high-entropy tokens, short-lived rate-limited OTPs), and I agree with it. Noted only because auditors will ask. No change needed.

**L-2 · No explicit HTTPS enforcement in code.** Render terminates TLS, and no `http://` production endpoint exists outside `app.json` fallbacks (see S-4 below). **Fix:** add HSTS via `@fastify/helmet` — which is not currently installed, so there are **no security headers at all**.

**L-3 · Location data is never persisted** — `rideSocket.ts:89-101` re-emits GPS without writing it to the DB. Genuinely good for privacy. **But there is no stated retention policy anywhere**, which you'll need for the store privacy questionnaires. **Fix:** document it; the honest answer ("location is transient and never stored") is a strong one.

**L-4 · No PCI exposure.** Confirmed: no raw card data anywhere. All payments are phone-number-plus-MoMo-prompt through Moolre. Correctly delegated — no PCI scope.

**L-5 · `console.log` leftovers in production paths.** `rider/app/ride/type.tsx:934` logs the payment-initiation response client-side.

**L-6 · 8 `RATE_LIMIT_*` env vars and `SEED_ZONE_ADJACENCY` are undocumented** in `apps/server/.env.example`. `apps/rider/.env.example` omits the Cloudinary vars, and `apps/driver` has **no `.env.example` at all**.

### Secrets in version control — CLEAN ✅

Scanned all 93 commits for live keys, private keys, and credentialed connection strings. **Only placeholders found** (`DEPLOY.md:82,97` use `<user>:<password>`). `.gitignore` correctly excludes `.env*` with `.example` exemptions, and `git ls-files` confirms only `.example` files are tracked. The local untracked `apps/driver/.env` contains the public Cloudinary values (see H-6) and no true secrets. **This is handled well.**

---

## 4. Test Coverage & Quality

### What exists

| Suite | Files | Tests | Result |
|---|---|---|---|
| `packages/shared` (vitest) | 4 | 86 | ✅ All pass (~0.9s) |
| `apps/server` (vitest, real Postgres) | 26 | 259 pass, 1 skipped | ✅ All pass (~13s) |
| `apps/rider` | 0 | 0 | ❌ None |
| `apps/driver` | 0 | 0 | ❌ None |
| `packages/mobile-shared` | 0 | 0 | ❌ None |
| E2E (Detox/Maestro/Playwright) | 0 | 0 | ❌ None |

**Total: 345 passing tests, all backend.** No coverage tool is configured — no `@vitest/coverage-*` dependency, no thresholds.

### Estimated coverage by surface

- **Pure domain logic (pricing, ranking, geo, best-fit): ~95%.** Excellent — every pricing branch and ranking rule is exercised.
- **Server services (ride lifecycle, payments, auth, OTP, USSD, assembly): ~80%.** Strong. Integration-style tests run against a real Postgres via `src/test/setup.ts` with a `dbHostGuard` preventing accidental prod writes — a genuinely thoughtful safeguard.
- **Server routes: ~60%.** `auth`, `rides`, `driver`, `ratings`, `webhooks` are covered. **`zones.ts`, `ussd.ts`, and `demoOtp.ts` route handlers have no direct route tests** (though `ussdHandler` and `demoOtp` services are tested).
- **Mobile (5,073 lines of screens + ~1,500 lines of shared components): 0%.** The two most complex files in the repo — `rider/app/ride/type.tsx` (1,357 lines) and `driver/app/(tabs)/index.tsx` (1,210 lines) — are entirely untested.
- **Realtime (`rideSocket.ts`): ~0% directly.** Emissions are asserted indirectly via mocks; the authorization functions `authorizeRideAccess` and `authorizeDriverRide` are **security-critical and have no direct tests**.

**Weighted estimate: ~45–50% of total surface area, concentrated almost entirely on the backend.**

### The skipped test is meaningful

`assembly.test.ts:469` — `it.skip("initiates a COLLECTION Payment for every active passenger...")`, skipped in the most recent commit (`97456a6`, "defer to Phase 5"). This test is skipped **because the feature isn't wired** (see the §1 discrepancy table). Restoring it requires implementing depart-time collection, not fixing a test.

### CI/CD — absent

**No `.github/` directory. No CI of any kind.** Nothing runs tests, type-checks, or audits on push. `render.yaml` auto-deploys `main` on push with **no gate** — a commit that breaks the build or the tests deploys straight to production. The one safeguard is `healthCheckPath: /health`.

`render.yaml` is otherwise well-constructed: secrets via `sync: false`, safe feature-flag defaults, correct build ordering for the shared package.

### Monitoring — absent

No Sentry, no Crashlytics, no APM, no structured error tracking. Fastify's Pino logger is enabled (`index.ts:30`) and goes to Render's log stream — with the secret-leaking `console.log` from H-2 mixed in.

### Code quality

**No linting or formatting configured anywhere** — no ESLint, no Prettier, no Biome, in any of the five workspaces. Despite that, style is remarkably consistent, which suggests disciplined single-author work rather than tooling.

**Strengths, genuinely:**
- Comment quality is exceptional — comments explain *why*, cite prior bugs and the reasoning behind decisions (e.g. `index.ts:19-21` on the poll interval, `webhooks.ts:31-38` on the security gate). This is the most valuable thing in the repo for someone returning after a break.
- Money is integer pesewas throughout, enforced by convention and a schema-level comment. No float arithmetic anywhere.
- Clean layering: `routes → services → db`, with pure domain logic isolated in `packages/shared`.
- Errors are typed classes mapped to HTTP codes, not strings.
- Concurrency is handled deliberately: atomic conditional updates, DB-level uniqueness for payment idempotency, explicit transactions.

**Weaknesses:**
- **Two oversized files:** `rider/app/ride/type.tsx` (1,357 lines, ~10 components) and `driver/app/(tabs)/index.tsx` (1,210 lines, ~10 components). Both are the highest-churn, highest-risk files and both are untested.
- **Duplicated logic:** `getDriverInfo` is copy-pasted between `routes/rides.ts:69-89` and `routes/driver.ts:103-118` — identical implementations. Fare-computation logic is re-derived in `routes/driver.ts:709` (`/complete`) and again in `finalizeRideCompletion`.
- **`app.json` `extra.SERVER_URL` is `http://localhost:3000` in both apps** — a broken production fallback (see S-4).
- **State management is consistent** (React Query for server state, `AuthContext` for auth, local `useState` for UI) — no drift here.
- **Architecture has not drifted.** Feature-based service layering is followed consistently; the only inconsistency is `POST /driver/profile` living in `routes/auth.ts:219` while `PATCH /driver/profile` lives in `routes/driver.ts:281`.

---

## 5. App Store / Play Store Readiness

| # | Requirement | Status | Detail |
|---|---|---|---|
| S-1 | Privacy policy exists | ❌ **FAIL** | No document in the repo. `PhoneScreen.tsx:63` tells users they agree to a privacy policy that doesn't exist and isn't linked. **Both stores require a reachable URL.** |
| S-2 | Privacy policy matches actual collection | ❌ **FAIL** | Nothing to compare. You collect phone, name, GPS, MoMo number, driver photos, vehicle details, ride history. Apple's Privacy Nutrition Label and Google's Data Safety form both need this itemized. |
| S-3 | In-app account deletion | ❌ **FAIL** | Absent (H-5). **Automatic rejection on both stores.** |
| S-4 | Clean production config | ❌ **FAIL** | `rider/app.json:35` and `driver/app.json:37` both set `extra.SERVER_URL: "http://localhost:3000"` — a cleartext HTTP fallback shipped in the bundle. It's only reached if `EXPO_PUBLIC_API_URL` is unset at build time, but that's exactly the kind of build mistake that ships. iOS ATS would block it, so the app would silently fail rather than fall back. |
| S-5 | App icons | ❌ **FAIL** | **No `assets/` directory exists in either app.** `adaptiveIcon` declares only `backgroundColor` with no `foregroundImage`. Both stores require a 1024×1024 icon. |
| S-6 | Splash screen | ❌ **FAIL** | No `expo-splash-screen` config, no asset. |
| S-7 | Store screenshots & metadata | ❌ **FAIL** | None in the repo. Needs screenshots per device class, descriptions, keywords, support URL. |
| S-8 | Build config (EAS) | ❌ **FAIL** | **No `eas.json` in either app.** No build profiles, no credentials setup. Cannot produce a store binary today. |
| S-9 | Versioning | ⚠️ **PARTIAL** | Both at `version: "0.0.1"`. **No iOS `buildNumber`, no Android `versionCode`** — both required and must increment per upload. |
| S-10 | Bundle identifiers | ✅ **PASS** | `gh.edu.ug.rida.rider` / `gh.edu.ug.rida.driver` — valid, distinct, sensibly namespaced. |
| S-11 | Permissions justified | ⚠️ **PARTIAL** | Location: declared with a clear `locationWhenInUsePermission` string in both apps, and genuinely used. **But the driver app depends on `expo-image-picker` and uses it (`account.tsx:48`) without declaring the plugin or a photo-library usage string in `app.json`** — iOS will crash on access or reject at review. No excessive permissions otherwise; nothing requests contacts, microphone, or background location. |
| S-12 | Background location | ✅ **PASS** (by omission) | Only `whenInUse` requested. Note: a driver app that can't track in the background is a **product limitation** — driver GPS stops when the app backgrounds. |
| S-13 | Age rating | ⚠️ **NEEDS DECISION** | Location tracking + payments + user-to-user contact → likely 12+ / Teen. Ghana-specific: Moolre MoMo payments may trigger additional financial-services disclosure. No age gate exists in the app. |
| S-14 | Crash reporting | ❌ **FAIL** | None (H-7). Not store-mandated, but you'd be flying blind post-launch. |
| S-15 | Push notification setup | ❌ **FAIL** | `expo-notifications` not installed. No APNs/FCM credentials. |
| S-16 | Backend scaling readiness | ⚠️ **PARTIAL** | `render.yaml:8` is `plan: free` — cold starts, no autoscaling, spins down when idle. Neon pooled connections are configured thoughtfully (`connection_limit=5`, `pgbouncer=true`), and ROADMAP §3 honestly flags pool contention as a known issue. **Blockers for >1 instance:** in-memory USSD sessions and the in-process timeout sweeper (M-7). |
| S-17 | Terms of Service | ❌ **FAIL** | Referenced at `PhoneScreen.tsx:63`, doesn't exist. Needed for a marketplace app carrying liability for physical transport. |
| S-18 | Support contact | ❌ **FAIL** | Both stores require a support URL or email. "Help & support" is a "coming soon" alert (`account.tsx:90`). |
| S-19 | Content guidelines for ride-hailing | ⚠️ **NEEDS DECISION** | Both stores scrutinize transport apps for driver vetting and user safety. **Zero safety features and zero background checks** will likely draw review questions. |

**Score: 1 pass, 5 partial, 13 fail.** The app cannot be submitted today — and notably, most failures are hours-to-days of work, not months. S-3 (deletion), S-1/S-2 (privacy policy), and S-5/S-6/S-8 (assets and build config) are the true gates.

---

## 6. Prioritized Roadmap

### Must fix before launch

*Legal, security, or store-mandated. Cannot ship without these.*

1. **Admin capability for driver approval** (C-1) — `requireAdmin` middleware, approve/reject/list routes, audit log, minimal UI, first-admin seed script. *Largest single item; start here.*
2. **In-app account deletion** (H-5, S-3) — `DELETE /me` with anonymization respecting `onDelete: Restrict` on rides; UI in both apps. Automatic store rejection otherwise.
3. **Privacy policy + Terms of Service** (S-1, S-2, S-17) — written, hosted, linked from `PhoneScreen.tsx:63`, matched against actual collection for both stores' privacy forms.
4. **Authenticate `POST /ussd/callback`** (C-2) — Moolre gateway IP allowlist plus a shared secret; per-msisdn rate limiting.
5. **Remove secret-leaking logs and rotate `MOOLRE_WEBHOOK_SECRET`** (H-2) — assume the current secret is compromised via retained Render logs.
6. **Fix production OTP config** (H-4) — `render.yaml` default to `moolre`; refuse to boot with `DummyOtpService` under `NODE_ENV=production`; delete the OTP `console.log`.
7. **Constant-time webhook secret comparison** (H-3) — `crypto.timingSafeEqual`.
8. **Patch critical/high dependencies** (H-1) — prioritize `ws`, `fastify`, `socket.io`, `axios`.
9. **App icons, splash screens, `eas.json`, `buildNumber`/`versionCode`** (S-5, S-6, S-8, S-9) — mechanical but strictly blocking.
10. **Fix `app.json` production config** (S-4) — remove the `localhost` fallback or point it at the real server.
11. **Declare `expo-image-picker` plugin + photo-library usage string in the driver app** (S-11) — otherwise an iOS crash or review rejection.
12. **Driver payout network selection** (M-1) — capture `payoutChannel`/`payoutPhone`; misdirected earnings are the fastest way to lose your driver supply.
13. **Server-side signed Cloudinary uploads** (H-6).
14. **Push notifications** — a driver who can't be reached when backgrounded cannot function. Add `expo-notifications`, APNs/FCM credentials, device-token storage, and server-side send on broadcast/match/arrival.
15. **Crash reporting** (H-7) — Sentry across all three deployables.
16. **Basic safety feature set** — at minimum an SOS button with campus security and emergency contacts, plus trip sharing. Shipping a campus transport app to young users with zero safety features is the recommendation I'd most strongly defend.
17. **Rider↔driver contact** — at minimum a masked or direct call button. Riders and drivers currently have no way to find each other at pickup.

### Should fix before launch

*Serious quality, trust, or operational gaps. Ship without these only knowingly.*

18. **CI pipeline** — GitHub Actions running `tsc --noEmit`, both test suites, and `npm audit --audit-level=high` on every PR; gate the Render deploy on it.
19. **Linting** — ESLint + Prettier across all workspaces, with a no-`console`-in-production-paths rule.
20. **Decide the payment-collection model** — today MoMo is voluntary post-ride and CASH commission is recorded but uncollectable. Either wire collection at depart (restoring `assembly.test.ts:469`) or design an explicit debt/chase flow. **This is a business-model decision, not a bug.**
21. **Refund capability** (Payments table) — the `REFUND` enum exists with no implementation; you will need it in week one of real disputes.
22. **Driver→rider ratings** — the schema already supports it; driver-side trust is currently one-directional.
23. **Mobile test coverage** — start with `useRideTracking`, the `AuthContext`, and the payment flow in `type.tsx`. Then one Maestro e2e covering request→match→complete→pay.
24. **Direct tests for `authorizeRideAccess` / `authorizeDriverRide`** (`rideSocket.ts:115-137`) — security-critical, currently untested.
25. **Redis-backed USSD sessions + externalized timeout sweeper** (M-7) — prerequisites for more than one server instance.
26. **Explicit `select` clauses / response schemas** on all routes (M-5).
27. **Security headers** — add `@fastify/helmet`; none are set today (L-2).
28. **Lock down CORS** (M-2, M-3) — HTTP and Socket.io.
29. **Refresh-token rotation with reuse detection** (M-4).
30. **Upgrade Render from the free plan** (S-16) — cold starts will break ride requests.
31. **ETA calculation** — riders currently see a driver moving on a map with no arrival estimate.
32. **Support channel** (S-18) — even just an email link replacing the "coming soon" alert.
33. **Rider profile editing** — currently a dead end (`account.tsx:72`) despite backend precedent existing for drivers.
34. **Driver navigation hand-off** — `Linking.openURL` to Google Maps; drivers are currently navigating by zone name alone.
35. **Complete the earnings dashboard** — show commission owed and net, not just gross.

### Can ship without, fix post-launch

36. Decompose `type.tsx` (1,357 lines) and driver `index.tsx` (1,210 lines).
37. Extract the duplicated `getDriverInfo` into a shared service.
38. Delete `PaystackPaymentService`, and `MapboxStaticMap` if confirmed unused.
39. Remove the 8 "coming soon" tiles, or replace them with honest empty states.
40. Fix the stale "Photo upload coming soon" copy at `driver/app/onboarding.tsx:126`.
41. Document the 8 `RATE_LIMIT_*` vars and `SEED_ZONE_ADJACENCY`; add `apps/driver/.env.example`; add Cloudinary vars to the rider example.
42. Update the stale test counts and the incorrect Phase 4c status in `ROADMAP.md`.
43. Add a `README.md` — there is none, and a 320KB `ROADMAP.md` is not a substitute for onboarding.
44. Coverage tooling with thresholds.
45. Explicit driver reject action.
46. Receipts (email/downloadable), favourites, scheduled rides, promo codes, wallet, i18n.
47. Pagination on ride history (currently capped at 50).
48. Geofencing and student-eligibility checks — **if** the product actually requires campus-restricted access. Worth deciding deliberately: right now "CampusRide" is campus-themed but not campus-restricted in any enforceable way.
49. Resolve the `AWAITING_OTP` bucketing TODO (`paymentFlow.ts:339`).
50. Deep-link validation (M-10) — before any sensitive flow becomes deep-linkable.

---

## Closing Note

The gap between this codebase's backend and its frontend/operational maturity is unusually wide. The ride engine, payment idempotency, state machine, and authorization model are the parts that are genuinely hard to retrofit, and they're already done and tested. What's missing — admin tooling, store assets, account lifecycle, CI, monitoring, safety features — is well-understood work with no research risk.

The two findings I'd resist cutting under schedule pressure are **driver approval** (C-1) and **safety features** (item 16). Everything else is a defensible trade-off; those two carry real-world risk to actual people using a transport service.
