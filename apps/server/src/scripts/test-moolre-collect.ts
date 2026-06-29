/**
 * THROWAWAY diagnostic — NOT run by the test suite or CI, and must not be
 * committed. Validates the documented 3-call / 7-step Moolre LIVE collection
 * flow before we build the real fix. Production code is untouched: this drives
 * the REAL MoolrePaymentService.collect() so we exercise the live classifier.
 *
 * Usage (requires MOOLRE_ENABLED=true and LIVE creds in .env —
 * MOOLRE_BASE_URL=https://api.moolre.com, MOOLRE_API_USER, MOOLRE_PRIVATE_KEY,
 * MOOLRE_ACCOUNT_NUMBER — plus YOUR OWN phone as the payer for a trivial debit):
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/test-moolre-collect.ts +233XXXXXXXXX [MTN|TELECEL|AT]
 *
 * Documented flow (one externalRef reused across all three calls):
 *   CALL 1: collect(no otpcode)            -> TP14  (OTP SMS sent to payer)
 *   CALL 2: collect(otpcode), SAME ref     -> TP17  ("Phone no. Verification Successful")
 *   CALL 3: collect(no otpcode), SAME ref  -> TR099 (PIN prompt pushed) -- KEY ASSERTION;
 *           NOT TP13 (duplicate ref). Then payer enters MoMo PIN -> webhook -> settled.
 *
 * NOTE ON THE REAL CLASSIFIER (intentional, per the test plan):
 *   - TP14 -> collect() returns kind "OTP_REQUIRED".
 *   - TP17 -> currently falls through to kind "PROMPT_SENT" (only if the body
 *     carries status:1; otherwise post() THROWS — we catch and read code= from it).
 *   - TR099 -> kind "PROMPT_SENT".
 *   - TP13 / AIN0x are HARD_FAILURE_CODES -> collect() THROWS; we parse code=
 *     out of the thrown message so the raw code is still reported.
 * We read the RAW code for every call, not the kind.
 */
import * as readline from "node:readline/promises";

import { config } from "../config";
import { MoolrePaymentService } from "../services/payment/MoolrePaymentService";
import type { CollectParams, Channel } from "../services/payment/PaymentService";
import { pesewasToGhs } from "../services/payment/amounts";

const TEST_AMOUNT_PESEWAS = 50; // GHS 0.50 — small real debit
const VALID_CHANNELS: Channel[] = ["MTN", "TELECEL", "AT"];

/** Minimal view of Moolre's raw body for printing (code/message/status/data). */
interface MoolreLike {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  data?: unknown;
}

interface CallReport {
  kind?: string;
  rawCode?: string;
  raw?: MoolreLike;
  /** Present when the real classifier rejected the body (hard-failure code, or TP17 w/o status:1). */
  error?: Error;
  httpStatusNote: string;
}

/**
 * Drives the REAL collect(). On success we have outcome.raw; on a classifier
 * rejection we only get a thrown Error whose message embeds `code=...` (see
 * MoolrePaymentService.post()), so we parse the code back out of it.
 */
async function doCollect(service: MoolrePaymentService, params: CollectParams): Promise<CallReport> {
  try {
    const outcome = await service.collect(params);
    const raw = outcome.raw as MoolreLike | undefined;
    const rawCode = typeof raw?.code === "string" ? raw.code : undefined;
    return {
      kind: outcome.kind,
      rawCode,
      raw,
      httpStatusNote: "200 (Moolre returns 200 for success AND body-level failures; the body `code` is the real signal)",
    };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const codeMatch = /code=([A-Z0-9]+)/.exec(e.message);
    const httpMatch = /HTTP (\d+)/.exec(e.message);
    return {
      error: e,
      rawCode: codeMatch?.[1],
      httpStatusNote: httpMatch ? httpMatch[1] : "200 (body-level rejection — see code below; not an HTTP error)",
    };
  }
}

function printReport(label: string, externalRef: string, expectedCode: string, report: CallReport): void {
  console.log(`\n===== ${label} =====`);
  console.log("externalRef (same across all three):", externalRef);
  console.log("HTTP status:", report.httpStatusNote);
  console.log("outcome.kind:", report.kind ?? "(none — collect() threw)");
  console.log("raw.code:", report.rawCode ?? "(unknown)");
  if (report.error) {
    console.log("collect() THREW (real classifier rejected the body):");
    console.log("  ", report.error.message);
  }
  if (report.raw) {
    const r = report.raw;
    console.log("raw.message:", r.message);
    console.log("raw.status:", r.status);
    console.log("raw.data:", JSON.stringify(r.data));
    console.log("full parsed body:", JSON.stringify(report.raw, null, 2));
  }
  const ok = report.rawCode === expectedCode;
  console.log(ok ? `EXPECTATION MET: code=${expectedCode}` : `UNEXPECTED: expected code=${expectedCode}, got code=${report.rawCode ?? "(unknown)"}`);
}

async function main() {
  const phone = process.argv[2];
  const channelArg = (process.argv[3] ?? "MTN").toUpperCase();
  if (!phone) {
    console.error("Usage: test-moolre-collect.ts <your-phone> [MTN|TELECEL|AT]");
    process.exit(1);
  }
  if (!VALID_CHANNELS.includes(channelArg as Channel)) {
    console.error(`Invalid channel "${channelArg}". Use one of: ${VALID_CHANNELS.join(", ")}`);
    process.exit(1);
  }
  const channel = channelArg as Channel;

  if (!config.moolre.enabled) {
    console.error("Set MOOLRE_ENABLED=true (and the LIVE Moolre keys) in .env before running this.");
    process.exit(1);
  }

  const isLive = !config.moolre.baseUrl.includes("sandbox");
  console.log("--- Config (no secret values) ---");
  console.log("MOOLRE_BASE_URL:", config.moolre.baseUrl, isLive ? "(LIVE)" : "(sandbox)");
  console.log("MOOLRE_API_USER present:", config.moolre.apiUser.length > 0);
  console.log("MOOLRE_PRIVATE_KEY present:", config.moolre.privateKey.length > 0);
  console.log("MOOLRE_ACCOUNT_NUMBER present:", config.moolre.accountNumber.length > 0);
  console.log("Payer:", phone, "| Channel:", channel, "| Amount:", pesewasToGhs(TEST_AMOUNT_PESEWAS), "GHS");
  if (isLive) {
    console.log("\n!!! LIVE MODE — this debits a REAL", pesewasToGhs(TEST_AMOUNT_PESEWAS), "GHS from", phone, "!!!");
  }
  console.log("---------------------------------");

  const service = new MoolrePaymentService({
    baseUrl: config.moolre.baseUrl,
    apiUser: config.moolre.apiUser,
    publicKey: config.moolre.publicKey,
    privateKey: config.moolre.privateKey,
    accountNumber: config.moolre.accountNumber,
  });

  // ONE externalRef, reused across all three calls (this is the whole point).
  const externalRef = `collect-live-test-${Date.now()}`;
  const base = { rideId: "live-collect-test", payerPhone: phone, channel, amountPesewas: TEST_AMOUNT_PESEWAS, externalRef };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // CALL 1 — initiate, no otpcode. Expect TP14 (OTP SMS sent).
    console.log("\nCALL 1: collect() with NO otpcode — expect TP14 (OTP SMS sent)...");
    const call1 = await doCollect(service, base);
    printReport("CALL 1 (initiate, no otpcode)", externalRef, "TP14", call1);

    // Prompt for the OTP that just arrived by SMS.
    const otpcode = (await rl.question("\nEnter the OTP from the SMS, then press Enter: ")).trim();

    // CALL 2 — confirm OTP, SAME externalRef. Expect TP17 (verification successful).
    console.log("\nCALL 2: collect() WITH otpcode, SAME externalRef — expect TP17 (verification successful)...");
    const call2 = await doCollect(service, { ...base, otpcode });
    printReport("CALL 2 (confirm otpcode)", externalRef, "TP17", call2);

    // CALL 3 — re-initiate, NO otpcode, SAME externalRef. KEY ASSERTION: TR099 (PIN prompt), NOT TP13.
    console.log("\nCALL 3 (KEY ASSERTION): collect() with NO otpcode, SAME externalRef — expect TR099 (PIN prompt), NOT TP13...");
    const call3 = await doCollect(service, base);
    printReport("CALL 3 (re-initiate, same ref — KEY ASSERTION)", externalRef, "TR099", call3);

    if (call3.rawCode === "TP13") {
      console.log("\n############################################################");
      console.log("## KEY ASSERTION FAILED: CALL 3 returned TP13 (DUPLICATE REF).");
      console.log("## Same-externalRef reuse on call 3 does NOT work — Moolre");
      console.log("## treats it as a duplicate instead of pushing the PIN prompt.");
      console.log("## We need a DIFFERENT externalRef strategy for the 3rd call.");
      console.log("############################################################");
    } else if (call3.rawCode === "TR099") {
      console.log("\n>>> KEY ASSERTION PASSED: CALL 3 returned TR099 — same-ref reuse pushes the PIN prompt. <<<");
      console.log("\nCheck your phone — a MoMo PIN prompt should appear. Enter your PIN to approve.");
      console.log("(Settlement confirmation arrives via webhook, not this script — exiting.)");
    } else {
      console.log(`\n??? CALL 3 returned an UNEXPECTED code=${call3.rawCode ?? "(unknown)"} — neither TR099 nor TP13. Inspect the raw body above.`);
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("test-moolre-collect failed:", err);
  process.exit(1);
});
