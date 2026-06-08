/**
 * Manual, one-off script to verify real Moolre SANDBOX integration. NOT run
 * by the test suite or CI — tests always use DummyPaymentService (see
 * services/payment/DummyPaymentService.ts and services/active.ts).
 *
 * Usage (requires MOOLRE_ENABLED=true and MOOLRE_BASE_URL=https://sandbox.moolre.com,
 * MOOLRE_API_USER, MOOLRE_PUBLIC_KEY, MOOLRE_PRIVATE_KEY, MOOLRE_ACCOUNT_NUMBER
 * in .env, plus a real sandbox phone number to test against):
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/moolreSandbox.ts +233XXXXXXXXX
 *
 * OPEN QUESTION TO CONFIRM WITH MOOLRE (blocks instant per-ride payout):
 * Does a successfully collected amount land in the Moolre account balance
 * INSTANTLY (available to disburse to the driver immediately, as the Phase
 * 4a design assumes), or only after a settlement delay? If there's a delay,
 * the disburse step below will likely fail with 400_INSUFFICIENT_BALANCE
 * immediately after a successful collection — that result is itself the
 * answer to this question.
 */
import { config } from "../config";
import { MoolrePaymentService } from "../services/payment/MoolrePaymentService";
import { pesewasToGhs } from "../services/payment/amounts";

const TEST_AMOUNT_PESEWAS = 100; // GHS 1.00 — keep tiny for sandbox testing

async function main() {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: moolreSandbox.ts <phone>");
    process.exit(1);
  }
  if (!config.moolre.enabled) {
    console.error("Set MOOLRE_ENABLED=true (and the Moolre keys) in .env before running this.");
    process.exit(1);
  }

  const service = new MoolrePaymentService({
    baseUrl: config.moolre.baseUrl,
    apiUser: config.moolre.apiUser,
    publicKey: config.moolre.publicKey,
    privateKey: config.moolre.privateKey,
    accountNumber: config.moolre.accountNumber,
  });

  const externalRef = `sandbox-collect-${Date.now()}`;
  console.log(`\n1. Collection: charging ${pesewasToGhs(TEST_AMOUNT_PESEWAS)} GHS from ${phone}...`);
  const collectResult = await service.collect({
    rideId: "sandbox-ride",
    payerPhone: phone,
    channel: "MTN",
    amountPesewas: TEST_AMOUNT_PESEWAS,
    externalRef,
  });
  console.log("Collect result:", JSON.stringify(collectResult, null, 2));

  console.log(`\n2. Status check for ${externalRef}...`);
  const statusResult = await service.getStatus(externalRef);
  console.log("Status result:", JSON.stringify(statusResult, null, 2));

  console.log("\n3. Validate + transfer (only run if the account has balance — see open question above).");
  console.log("   Validating recipient...");
  try {
    const validation = await service.validateRecipient({ phone, channel: "MTN" });
    console.log("Validate result:", JSON.stringify(validation, null, 2));

    const transferRef = `sandbox-transfer-${Date.now()}`;
    console.log(`   Transferring ${pesewasToGhs(TEST_AMOUNT_PESEWAS)} GHS to ${phone}...`);
    const disburseResult = await service.disburse({
      rideId: "sandbox-ride",
      recipientPhone: phone,
      channel: "MTN",
      amountPesewas: TEST_AMOUNT_PESEWAS,
      externalRef: transferRef,
    });
    console.log("Disburse result:", JSON.stringify(disburseResult, null, 2));
    // A 400_INSUFFICIENT_BALANCE here right after a successful collection
    // answers the settlement-delay question above: balance is NOT instant.
  } catch (err) {
    console.error("Validate/transfer step failed:", err);
  }
}

main().catch((err) => {
  console.error("Sandbox script failed:", err);
  process.exit(1);
});
