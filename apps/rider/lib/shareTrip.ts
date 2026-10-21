import { Alert, Share } from "react-native";
import type { RideDriverInfo } from "@rida/mobile-shared";

/** "Silver Toyota Corolla": what the rider looks for at the pickup. */
export function carDescription(
  driver: Pick<RideDriverInfo, "carColor" | "carMake" | "carModel">,
): string {
  return [driver.carColor, driver.carMake, driver.carModel].filter(Boolean).join(" ");
}

/**
 * The words "Share trip" sends: where the rider is going and the car they're
 * in, so whoever gets it knows what to look for. No link: the live tracking
 * link is only made by an SOS (POST /rides/:id/sos).
 */
export function tripShareMessage(input: {
  /** A real place name (pickupPlace), or null: the message then gives only where the rider's going. */
  pickup: string | null;
  dropoff: string;
  driver: Pick<RideDriverInfo, "name" | "carColor" | "carMake" | "carModel" | "plate">;
}): string {
  const driverName = input.driver.name.trim().split(/\s+/)[0] || "my driver";
  const car = carDescription(input.driver);
  const vehicle = [car, input.driver.plate ? `plate ${input.driver.plate}` : ""]
    .filter(Boolean)
    .join(", ");
  return (
    `I'm on a CampusRide ${input.pickup ? `from ${input.pickup} ` : ""}to ${input.dropoff}. ` +
    `My driver is ${driverName}${vehicle ? ` (${vehicle})` : ""}.`
  );
}

/** Opens the phone's share sheet with the trip; never throws. */
export async function shareTrip(input: Parameters<typeof tripShareMessage>[0]): Promise<void> {
  try {
    await Share.share({ message: tripShareMessage(input) });
  } catch {
    Alert.alert("Couldn't share your trip", "Please try again.");
  }
}
