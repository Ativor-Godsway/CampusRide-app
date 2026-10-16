import { SERVICE_AREA_POLYGON, isInServiceArea } from "./serviceArea";
import type { LatLng } from "../driver/requestsNearYou";

/**
 * Where an App Store / Google Play reviewer's phone "is" in the review demo
 * (the apps treat a review demo account as on campus, wherever the reviewer
 * really is): the middle of the CampusRide area.
 */
function middleOfArea(): LatLng {
  const n = SERVICE_AREA_POLYGON.length;
  const centre = {
    latitude: SERVICE_AREA_POLYGON.reduce((sum, [lat]) => sum + lat, 0) / n,
    longitude: SERVICE_AREA_POLYGON.reduce((sum, [, lng]) => sum + lng, 0) / n,
  };
  if (isInServiceArea(centre)) return centre;
  const [lat, lng] = SERVICE_AREA_POLYGON[0]!;
  return { latitude: lat, longitude: lng };
}

export const REVIEW_DEMO_POSITION: LatLng = middleOfArea();
