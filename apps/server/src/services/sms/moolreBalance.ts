import { logger } from "../../lib/logger";
import { reportMessage, type ReportContext } from "../../lib/monitoring";
import type { MoolreSmsConfig } from "./MoolreSmsService";

/**
 * A warning before the Moolre SMS balance runs out (Stage 5): when it does,
 * nobody can sign in, because login codes go by SMS.
 *
 * Moolre's public documentation doesn't list a balance call; this is the one
 * Moolre's own WordPress plugin uses (POST /open/sms/query, type 2, answered
 * with `data.balance`). If it ever stops answering, that is reported once and
 * logged, and the balance has to be checked by hand on Moolre's dashboard
 * (DEPLOY.md, "Moolre SMS balance").
 */

const BALANCE_PATH = "/open/sms/query";
const TYPE_BALANCE = 2;

/** The SMS balance Moolre reports, or null when it can't be read. */
export async function readMoolreSmsBalance(
  cfg: Pick<MoolreSmsConfig, "baseUrl" | "apiUser" | "vasKey">,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const response = await fetchFn(`${cfg.baseUrl}${BALANCE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-USER": cfg.apiUser,
        "X-API-VASKEY": cfg.vasKey,
      },
      body: JSON.stringify({ type: TYPE_BALANCE }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { balance?: unknown } };
    const balance = Number(body?.data?.balance);
    return Number.isFinite(balance) ? balance : null;
  } catch {
    return null;
  }
}

export interface BalanceWatchOptions {
  cfg: Pick<MoolreSmsConfig, "baseUrl" | "apiUser" | "vasKey">;
  /** Warn below this balance (MOOLRE_SMS_LOW_BALANCE, default 100). */
  lowBalance: number;
  fetchFn?: typeof fetch;
  report?: (message: string, context: ReportContext) => void;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * One balance check. Below `lowBalance` it warns (Sentry and the logs) at
 * most once a day; a balance that can't be read is reported once per
 * process, then only logged.
 */
export function createBalanceCheck(opts: BalanceWatchOptions): () => Promise<void> {
  const report = opts.report ?? reportMessage;
  const now = opts.now ?? Date.now;
  let lastLowWarning = -Infinity;
  let reportedUnreadable = false;

  return async () => {
    const balance = await readMoolreSmsBalance(opts.cfg, opts.fetchFn);
    if (balance === null) {
      logger.warn("Couldn't read the Moolre SMS balance; check it by hand", {
        alert: "moolre_balance_unreadable",
      });
      if (!reportedUnreadable) {
        reportedUnreadable = true;
        report("Couldn't read the Moolre SMS balance: check it by hand", {
          level: "warning",
          tags: { alert: "moolre_balance_unreadable" },
        });
      }
      return;
    }
    if (balance >= opts.lowBalance) {
      logger.info("Moolre SMS balance", { balance });
      return;
    }
    logger.warn("Moolre SMS balance is low", {
      alert: "moolre_balance_low",
      balance,
      lowBalance: opts.lowBalance,
    });
    if (now() - lastLowWarning < DAY_MS) return;
    lastLowWarning = now();
    report(`Moolre SMS balance is low: ${balance} left`, {
      level: "warning",
      tags: { alert: "moolre_balance_low" },
      extra: { balance, lowBalance: opts.lowBalance },
    });
  };
}
