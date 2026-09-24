/**
 * Unique, VALID Ghanaian phone numbers for test fixtures.
 *
 * Fixtures used to build obviously-fake strings like
 * "+233-auth-test-1790194783385-7". That worked while nothing validated the
 * column, but since the phone-canonicalisation work two things reject it:
 *
 *   - the auth routes normalize at the edge and 400 anything that is not a
 *     Ghanaian number, so a fake string cannot complete signup/login;
 *   - the User_phone_canonical_check CHECK constraint rejects it at the
 *     database, so even a direct Prisma write fails.
 *
 * So fixtures must now produce numbers that are structurally real. The shape
 * is "+233" followed by exactly 9 digits:
 *
 *   +233 | BBB      | MMM        | NNN
 *        | per-proc | ms of sec  | call counter
 *
 * A collision needs the same process seed, the same millisecond AND the same
 * counter value, which is not reachable in practice. Keeping the seed
 * per-process matters because vitest runs each test file in its own worker.
 */

let counter = 0;
const processSeed = Math.floor(Math.random() * 900) + 100; // 100–999

/** Returns a fresh, unique, structurally valid "+233XXXXXXXXX" number. */
export function uniqueGhanaPhone(): string {
  counter += 1;
  const ms = String(Date.now() % 1000).padStart(3, "0");
  const serial = String(counter % 1000).padStart(3, "0");
  return `+233${processSeed}${ms}${serial}`;
}
