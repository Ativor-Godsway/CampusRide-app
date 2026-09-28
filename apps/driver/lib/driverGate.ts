import type { AuthUser } from "@rida/mobile-shared";

/**
 * Where a signed-in DRIVER has to be before they may use the app, or null
 * when they are cleared for the tab shell. One rule, shared by the start
 * screen, the tab layout, onboarding and the waiting screen, so they can
 * never disagree and bounce a driver between each other.
 *
 * - No car details yet → onboarding.
 * - Not yet approved and no photo → back to onboarding: admins verify who
 *   the driver is from that photo, so the queue needs one. (Approved drivers
 *   from before the photo was required are left alone.)
 * - Submitted but not approved → the waiting-for-approval screen.
 */
export function driverSetupRoute(user: AuthUser): "/onboarding" | "/pending" | null {
  const driver = user.driver;
  if (!driver || !driver.carMake) return "/onboarding";
  if (!driver.isApproved && !driver.photoUrl) return "/onboarding";
  if (!driver.isApproved) return "/pending";
  return null;
}
