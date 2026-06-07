export interface EtaResult {
  minutes: number;
}

export interface RouteService {
  /** Get estimated travel time between two zones. */
  getEta(fromZoneId: string, toZoneId: string): Promise<EtaResult>;
}
