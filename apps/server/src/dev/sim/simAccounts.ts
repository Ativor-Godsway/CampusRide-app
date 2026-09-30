import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Fake-rider accounts for the simulator (docs/testing/SOLO_TESTING.md).
 *
 * Phones use the reserved "+2330…" prefix (a real Ghanaian number never
 * starts with 0 after the country code — see docs/phone-formats.md), narrowed
 * further to "+233099…" so the simulator's riders are distinguishable from
 * test-suite fixtures and the dev mock driver (+233000000001). Nothing ever
 * texts these numbers: the accounts are written straight to the database and
 * signed in with a locally minted token, never through OTP or Moolre.
 */
export const SIM_PHONE_PREFIX = "+233099";

/** Every simulator account's name starts with this, so it is obvious in any list. */
export const SIM_NAME_PREFIX = "Test ";

const FIRST_NAMES = [
  "Ama", "Kofi", "Akosua", "Kwame", "Abena", "Yaw", "Efua", "Kojo", "Adwoa", "Kwesi",
  "Esi", "Kwabena", "Afia", "Kweku", "Akua", "Fiifi", "Araba", "Nana", "Yaa", "Ekow",
];

export const MAX_SIM_RIDERS = FIRST_NAMES.length;

/** "+233099000001" … — "+233" followed by exactly nine digits, as the phone CHECK requires. */
export function simRiderPhone(index: number): string {
  return `${SIM_PHONE_PREFIX}${String(index + 1).padStart(6, "0")}`;
}

export function simRiderName(index: number): string {
  return `${SIM_NAME_PREFIX}${FIRST_NAMES[index % FIRST_NAMES.length]}`;
}

/** True only for a phone number in the simulator's own range. */
export function isSimulatorPhone(phone: string): boolean {
  return /^\+233099\d{6}$/.test(phone);
}

/**
 * Which accounts belong to the simulator: its phone range AND its name
 * prefix AND the RIDER role. All three, so a real account can never match by
 * sharing one of them.
 */
export const simAccountWhere: Prisma.UserWhereInput = {
  phone: { startsWith: SIM_PHONE_PREFIX },
  name: { startsWith: SIM_NAME_PREFIX },
  role: "RIDER",
};

export interface SimRider {
  id: string;
  name: string;
  phone: string;
}

/** Creates the first `count` simulator riders, reusing any that already exist. */
export async function ensureSimRiders(prisma: PrismaClient, count: number): Promise<SimRider[]> {
  const riders: SimRider[] = [];
  for (let i = 0; i < count; i++) {
    const phone = simRiderPhone(i);
    const name = simRiderName(i);
    const user = await prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, name, role: "RIDER" },
      select: { id: true, name: true, phone: true, role: true },
    });
    if (user.role !== "RIDER" || !user.name.startsWith(SIM_NAME_PREFIX)) {
      throw new Error(
        `Phone ${phone} already belongs to "${user.name}" (${user.role}), which is not a ` +
          `simulator rider. Refusing to use it.`,
      );
    }
    riders.push({ id: user.id, name: user.name, phone: user.phone });
  }
  return riders;
}
