/**
 * Recipient formatting for every SMS the product sends: login OTPs, USSD ride
 * notifications, SOS texts to an emergency contact, and the SUPPORT_CONTACT_PHONE
 * backstop all funnel through sendMoolreSms.
 *
 * Moolre's documented format is "233XXXXXXXXX". The old implementation only
 * stripped a leading "+", so a locally-stored number went out as
 * "0548608146". Moolre does accept that form in practice — production
 * deliveries to local-format numbers arrived — so these tests pin a
 * correctness and consistency contract, not a repair: the documented format,
 * and one stable `ref` per person regardless of how their number is stored.
 */
import { describe, it, expect, vi } from "vitest";
import { sendMoolreSms } from "./MoolreSmsService";

const cfg = {
  baseUrl: "https://sandbox.moolre.test",
  apiUser: "user",
  vasKey: "vaskey",
  senderId: "CampusRide",
};

/** Sends one message and returns the recipient Moolre would have received. */
async function recipientFor(phone: string): Promise<string> {
  const fetchFn = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: 1 }),
  });

  await sendMoolreSms(cfg, phone, "hello", { fetchFn: fetchFn as unknown as typeof fetch });

  const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as {
    messages: Array<{ recipient: string; ref: string }>;
  };
  return body.messages[0]!.recipient;
}

describe("Moolre recipient formatting", () => {
  it("sends a locally-stored number in the documented msisdn form", async () => {
    // This used to go out as "0548608146" — accepted by Moolre in practice,
    // but not the documented contract, and it split the idempotency ref.
    expect(await recipientFor("0548608146")).toBe("233548608146");
  });

  it("keeps a canonical number correct", async () => {
    expect(await recipientFor("+233548608146")).toBe("233548608146");
  });

  it("keeps a bare msisdn correct", async () => {
    expect(await recipientFor("233548608146")).toBe("233548608146");
  });

  it("normalizes through spaces and dashes", async () => {
    expect(await recipientFor("054-860 8146")).toBe("233548608146");
    expect(await recipientFor("+233 54 860 8146")).toBe("233548608146");
  });

  it("every equivalent input form produces the identical recipient", async () => {
    const forms = ["0548608146", "+233548608146", "233548608146", "054 860 8146"];
    const recipients = await Promise.all(forms.map(recipientFor));
    expect(new Set(recipients).size).toBe(1);
  });

  /**
   * An emergency contact may legitimately be a non-Ghanaian number — the
   * profile validator is deliberately lenient about that. Best-effort delivery
   * beats dropping the message: losing an SOS is worse than a failed send.
   */
  it("falls back to stripping the + for a non-Ghanaian number", async () => {
    expect(await recipientFor("+15551234567")).toBe("15551234567");
    expect(await recipientFor("15551234567")).toBe("15551234567");
  });

  it("puts the normalized recipient in the idempotency ref too", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 1 }) });
    await sendMoolreSms(cfg, "0548608146", "hello", {
      refPrefix: "otp",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as {
      messages: Array<{ ref: string }>;
    };
    expect(body.messages[0]!.ref).toMatch(/^otp:233548608146:\d+$/);
  });
});
