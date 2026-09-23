import type { PrismaClient, User } from "@prisma/client";

/**
 * Thrown when a provided emergency-contact phone isn't a plausible number.
 * Deliberately lenient (see isPlausiblePhone) — this is a convenience check
 * to catch typos, not an identity check: nothing is ever verified against
 * this number and no OTP is sent to it.
 */
export class InvalidEmergencyContactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEmergencyContactError";
  }
}

/**
 * Accepts Ghanaian local (0XXXXXXXXX) and international (+233...) forms, plus
 * spaces/dashes. Intentionally not strict E.164: an emergency contact may be
 * any number the rider can reach, and rejecting a valid-but-unusual format
 * would silently cost someone their only safety contact.
 */
function isPlausiblePhone(value: string): boolean {
  const digits = value.replace(/[\s()-]/g, "");
  return /^\+?\d{7,15}$/.test(digits);
}

export interface UpdateRiderProfileInput {
  name?: string;
  /** Pass null to CLEAR the contact; omit to leave it unchanged. */
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

/**
 * Partial profile update for a rider — mirrors PATCH /driver/profile on the
 * driver side (routes/driver.ts), same "omitted means unchanged, provided
 * must be valid" contract.
 *
 * `phone` is deliberately NOT updatable here: it is the login identity and
 * changing it would need a fresh OTP verification of the new number, which
 * is its own flow.
 *
 * The emergency-contact pair is validated together: a name with no number is
 * useless to an SOS, and a number with no name gives the recipient no idea
 * who is calling. Either both are set, or both are cleared.
 */
export async function updateRiderProfile(
  prisma: PrismaClient,
  userId: string,
  input: UpdateRiderProfileInput,
): Promise<User> {
  const data: {
    name?: string;
    emergencyContactName?: string | null;
    emergencyContactPhone?: string | null;
  } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new InvalidEmergencyContactError("name must not be empty");
    }
    data.name = name;
  }

  const contactTouched =
    input.emergencyContactName !== undefined || input.emergencyContactPhone !== undefined;

  if (contactTouched) {
    const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const rawName =
      input.emergencyContactName !== undefined
        ? input.emergencyContactName
        : current.emergencyContactName;
    const rawPhone =
      input.emergencyContactPhone !== undefined
        ? input.emergencyContactPhone
        : current.emergencyContactPhone;

    const name = rawName?.trim() ?? null;
    const phone = rawPhone?.trim() ?? null;

    const clearing = (name === null || name === "") && (phone === null || phone === "");

    if (clearing) {
      data.emergencyContactName = null;
      data.emergencyContactPhone = null;
    } else {
      if (!name) {
        throw new InvalidEmergencyContactError("emergencyContactName is required with a phone");
      }
      if (!phone) {
        throw new InvalidEmergencyContactError("emergencyContactPhone is required with a name");
      }
      if (!isPlausiblePhone(phone)) {
        throw new InvalidEmergencyContactError("emergencyContactPhone is not a valid phone number");
      }
      data.emergencyContactName = name;
      data.emergencyContactPhone = phone;
    }
  }

  if (Object.keys(data).length === 0) {
    throw new InvalidEmergencyContactError("At least one field is required to update");
  }

  return prisma.user.update({ where: { id: userId }, data });
}
