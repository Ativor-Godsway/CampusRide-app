import type { EtaResult, RouteService } from "./RouteService";

export class DummyRouteService implements RouteService {
  async getEta(_fromZoneId: string, _toZoneId: string): Promise<EtaResult> {
    return { minutes: 4 };
  }
}
