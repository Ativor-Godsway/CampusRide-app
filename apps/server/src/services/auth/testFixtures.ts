import type { OtpResult, OtpService } from "../otp/OtpService";
import { prisma } from "../../db/prisma";
import { uniqueGhanaPhone } from "../../test/testPhone";

/**
 * Returns a fresh, unique phone number for each call.
 *
 * Must be a STRUCTURALLY VALID Ghanaian number: the auth routes normalize at
 * the edge and 400 anything else, and the User_phone_canonical_check
 * constraint rejects it at the database. See src/test/testPhone.ts.
 */
export function uniqueTestPhone(): string {
  return uniqueGhanaPhone();
}

/** Captures sent OTP codes in-memory so tests can read the real (unhashed) code. */
export class CapturingOtpService implements OtpService {
  readonly sent = new Map<string, string>();

  async sendOtp(phone: string, code: string): Promise<OtpResult> {
    this.sent.set(phone, code);
    return { success: true };
  }

  codeFor(phone: string): string {
    const code = this.sent.get(phone);
    if (!code) throw new Error(`No OTP captured for ${phone}`);
    return code;
  }
}

/** Deletes all OtpCode rows for a phone (test cleanup). */
export async function cleanupOtpCodes(phone: string): Promise<void> {
  await prisma.otpCode.deleteMany({ where: { phone } });
}

/** Deletes a test user (and cascading RefreshToken/Driver rows) by id. */
export async function cleanupUser(userId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { id: userId } });
}
