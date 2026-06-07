export interface Zone {
  id: string;
  name: string;
  quadrant: string;
  latitude: number;
  longitude: number;
}

export interface ZoneAdjacency {
  id: string;
  zoneId: string;
  adjacentZoneId: string;
}
