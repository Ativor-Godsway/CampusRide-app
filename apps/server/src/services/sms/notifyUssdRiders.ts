import type { PrismaClient } from "@prisma/client";
import { sendSms } from "./sendSms";

/**
 * SMS counterpart to emitToRider/emitRideEvent for USSD-origin riders, who
 * have no app/socket to push to. Resolves phone(s) by riderId and fires
 * sendSms — never throws into the calling transition path; failures are
 * logged only, same fire-and-forget convention as broadcastRide.
 */
export async function notifyUssdRiders(
  prisma: PrismaClient,
  riderIds: string[],
  message: string,
): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: riderIds } },
      select: { id: true, phone: true },
    });
    await Promise.all(
      users.map((u) =>
        sendSms(u.phone, message).catch((err) => {
          console.error(`[notifyUssdRiders] failed to SMS rider ${u.id}:`, err);
        }),
      ),
    );
  } catch (err) {
    console.error("[notifyUssdRiders] failed to resolve rider phones:", err);
  }
}

export async function notifyUssdRider(prisma: PrismaClient, riderId: string, message: string): Promise<void> {
  return notifyUssdRiders(prisma, [riderId], message);
}
