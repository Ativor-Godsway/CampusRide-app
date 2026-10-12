/**
 * Transaction limits for operator scripts run from a laptop against a far
 * database (Ghana → Neon us-east-1: ~250 ms a round trip). Prisma's
 * interactive-transaction default is a 5 s timeout, which the first
 * production zones:realign hit (it rolled back cleanly, nothing changed). A script transaction holds few rows and runs rarely, so a long
 * limit costs nothing; the database's own lock_timeout (10 s) and
 * idle_in_transaction_session_timeout (60 s) still apply per statement and
 * per idle gap.
 */
export const SCRIPT_TX_OPTIONS = { timeout: 120_000, maxWait: 30_000 } as const;
