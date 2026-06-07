import type { OtpResult, OtpService } from "../otp/OtpService";
import { prisma } from "../../db/prisma";

let counter = 0;

/** Returns a fresh, unique phone number for each call. */
export function uniqueTestPhone(): string {
  counter += 1;
  return `+233-auth-test-${Date.now()}-${counter}`;
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
