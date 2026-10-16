import type { PrismaClient } from "@prisma/client";
import { logger } from "../../lib/logger";
import { reportMessage } from "../../lib/monitoring";
import { reviewDemoConfig } from "./config";

/**
 * The review demo's four accounts, all flagged isReviewDemo:
 * - the two reviewers sign in with (REVIEW_DEMO_RIDER_PHONE /
 *   REVIEW_DEMO_DRIVER_PHONE): created ready to use, the driver already
 *   approved, so a reviewer needs no sign-up, car details or approval;
 * - the two simulated people who serve them: a driver for the demo rider's
 *   requests, a rider for the demo driver's. Their "phone numbers" are
 *   placeholders no one can sign in with.
 *
 * Re-created on demand (a reviewer may try Delete account). Never taken over:
 * if a real, unflagged account already has one of the numbers, the demo stays
 * off for that number and the problem is logged and reported.
 */
export const SIM_DRIVER_PHONE = "review-demo:driver";
export const SIM_RIDER_PHONE = "review-demo:rider";

export type DemoAccount = "rider" | "driver" | "simDriver" | "simRider";

const PEOPLE: Record<DemoAccount, { name: string; role: "RIDER" | "DRIVER"; plate?: string }> = {
  rider: { name: "App Review Rider", role: "RIDER" },
  driver: { name: "App Review Driver", role: "DRIVER", plate: "DEMO 001" },
  simDriver: { name: "Kwame (demo driver)", role: "DRIVER", plate: "DEMO 002" },
  simRider: { name: "Ama (demo rider)", role: "RIDER" },
};

function phoneFor(account: DemoAccount): string | null {
  const cfg = reviewDemoConfig();
  if (account === "simDriver") return SIM_DRIVER_PHONE;
  if (account === "simRider") return SIM_RIDER_PHONE;
  return account === "rider" ? cfg.riderPhone : cfg.driverPhone;
}

const warnedTaken = new Set<string>();

/** The account's user id, creating it if needed; null if the demo is off or a real account has the number. */
export async function ensureDemoAccount(
  prisma: PrismaClient,
  account: DemoAccount,
): Promise<string | null> {
  if (!reviewDemoConfig().enabled) return null;
  const phone = phoneFor(account);
  if (!phone) return null;
  const person = PEOPLE[account];

  const existing = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, isReviewDemo: true, role: true },
  });
  if (existing && !existing.isReviewDemo) {
    if (!warnedTaken.has(account)) {
      warnedTaken.add(account);
      const setting = account === "rider" ? "REVIEW_DEMO_RIDER_PHONE" : "REVIEW_DEMO_DRIVER_PHONE";
      logger.error(
        `Review demo: a real account already uses ${setting}; the demo is off for that number`,
        {
          alert: "review_demo_number_taken",
        },
      );
      reportMessage(`Review demo: a real account already uses ${setting}`, {
        tags: { alert: "review_demo_number_taken" },
      });
    }
    return null;
  }

  const user =
    existing ??
    (await prisma.user.create({
      data: { phone, name: person.name, role: person.role, isReviewDemo: true },
      select: { id: true },
    }));
  if (person.role === "DRIVER") {
    await prisma.driver.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        carMake: "Toyota",
        carModel: "Corolla",
        carColor: "Silver",
        plate: person.plate,
        isApproved: true,
        isOnline: false,
      },
      update: { isApproved: true },
    });
  }
  return user.id;
}

/** Whether `phone` is a review demo number with a demo account behind it; the fixed code if so. */
export async function reviewDemoCodeFor(
  prisma: PrismaClient,
  phone: string,
): Promise<string | null> {
  const cfg = reviewDemoConfig();
  if (!cfg.enabled || !cfg.otp) return null;
  const account: DemoAccount | null =
    phone === cfg.riderPhone ? "rider" : phone === cfg.driverPhone ? "driver" : null;
  if (!account) return null;
  return (await ensureDemoAccount(prisma, account)) ? cfg.otp : null;
}
