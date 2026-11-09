import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DRIVER_EVENTS, type OfferClosedPayload } from "@rida/shared";
import { getRideSocket, useAuth, type FillSuggestionsResult } from "@rida/mobile-shared";
import { eligibleRidesQueryKey } from "./requests";

const FILL_SUGGESTIONS_KEY = ["fillSuggestions"] as const;

/**
 * Keeps the driver's requests lists in step with the server on every
 * screen (shared-ride dispatch rules, 2026-11):
 *
 * - `driver:requests_changed` — a seat in this car changed (a drop-off, a
 *   cancel or no-show, an undo, a rider added, the trip ended): the Home
 *   list and the mid-trip list refetch now, so a request that fits the
 *   freed seat shows at once;
 * - `ride:offer_closed` — the request was taken, cancelled or ran out: it
 *   leaves the mid-trip list at once too (lib/requests does the Home list);
 * - the socket connecting again — events may have been missed while it was
 *   down, so both lists refetch.
 *
 * Coming back to the foreground refetches them through the focus manager.
 * Mounted once in the root layout; renders nothing.
 */
export function RequestsSync() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    const socket = getRideSocket();
    const refetch = () => {
      void queryClient.invalidateQueries({ queryKey: eligibleRidesQueryKey });
      void queryClient.invalidateQueries({ queryKey: FILL_SUGGESTIONS_KEY });
    };
    const onClosed = (payload: OfferClosedPayload) => {
      queryClient.setQueriesData<FillSuggestionsResult>({ queryKey: FILL_SUGGESTIONS_KEY }, (data) =>
        data ? { ...data, suggestions: data.suggestions.filter((s) => s.requestRideId !== payload.rideId) } : data,
      );
    };
    socket.on(DRIVER_EVENTS.REQUESTS_CHANGED, refetch);
    socket.on(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
    socket.on("connect", refetch);
    return () => {
      socket.off(DRIVER_EVENTS.REQUESTS_CHANGED, refetch);
      socket.off(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
      socket.off("connect", refetch);
    };
  }, [isAuthenticated, queryClient]);

  return null;
}
