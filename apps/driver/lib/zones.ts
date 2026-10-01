import { useQuery } from "@tanstack/react-query";
import { getZoneRoutes, getZones, useAuth } from "@rida/mobile-shared";

/** The campus zones (fetched once a session). */
export const zonesQueryKey = ["zones"] as const;

/** Stored road routes between zones (fetched once a session; empty until precomputed). */
export const zoneRoutesQueryKey = ["zoneRoutes"] as const;

export function useZones() {
  const { isAuthenticated } = useAuth();
  return useQuery({ queryKey: zonesQueryKey, queryFn: getZones, enabled: isAuthenticated, staleTime: Infinity });
}

export function useZoneRoutes() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: zoneRoutesQueryKey,
    queryFn: getZoneRoutes,
    enabled: isAuthenticated,
    staleTime: Infinity,
    // An older server has no /zones/routes: draw straight lines, don't retry.
    retry: false,
  });
}
