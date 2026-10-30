import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import {
  activeRideStatusLine,
  estimateEtaMinutes,
  pickupPin,
  stopLabel,
  stopPoint,
} from "@rida/shared";
import {
  subscribeToRide,
  useDriverLocation,
  useServerEta,
  useSteadyEta,
  type ActiveRideSummary,
} from "@rida/mobile-shared";

export interface ActiveRideStatus {
  /** "Kwame is 3 min away", "Finding your driver…", "On your trip". */
  line: string;
  /** Minutes until the driver reaches the pickup, while they're on the way. */
  etaMinutes: number | null;
  /** Waiting for the assigned driver to arrive. */
  driverOnTheWay: boolean;
  /** Where the rider is going, by name. */
  destination: string;
}

/**
 * The live status of the rider's active ride, for the banner over the tabs
 * and the row on Home: the driver's pings (the ride's socket room) give the
 * minutes to the pickup.
 */
export function useActiveRideStatus(ride: ActiveRideSummary): ActiveRideStatus {
  const [driverAt, setDriverAt] = useState<{ latitude: number; longitude: number } | null>(null);
  const driverOnTheWay = ride.status === "MATCHED" || ride.status === "ARRIVED";

  // The ride screen leaves the ride's room when it closes, so re-join whenever
  // the tabs are back in view (joining twice is harmless).
  useFocusEffect(
    useCallback(() => {
      if (driverOnTheWay) subscribeToRide(ride.id);
    }, [ride.id, driverOnTheWay]),
  );
  useDriverLocation(driverOnTheWay ? ride.id : undefined, (payload) =>
    setDriverAt({ latitude: payload.lat, longitude: payload.lng }),
  );

  // The server's road time to this rider's pickup when it has one (campus
  // roads); else straight-line distance padded for roads. Kept steady, so the
  // row doesn't flick between two numbers as the driver's pings arrive.
  const serverSeconds = useServerEta(ride.id, driverOnTheWay ? "pickup" : null);
  const straightLine = driverOnTheWay ? estimateEtaMinutes(driverAt, stopPoint(pickupPin(ride), ride.pickupZone)) : null;
  const steady = useSteadyEta(
    driverOnTheWay ? (serverSeconds ?? (straightLine !== null ? straightLine * 60 : null)) : null,
    `${ride.id}:pickup`,
  );
  const etaMinutes = driverOnTheWay && steady ? Math.max(1, Math.round(steady.minutes)) : null;
  const line = activeRideStatusLine({
    status: ride.status,
    type: ride.type,
    legStatus: ride.legStatus,
    driverFirstName: ride.driver?.firstName,
    etaMinutes,
  });
  return {
    line,
    etaMinutes,
    driverOnTheWay,
    destination: stopLabel(ride.dropoffLabel, ride.dropoffZone.name),
  };
}
