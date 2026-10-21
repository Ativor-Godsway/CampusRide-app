import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import {
  DEFAULT_OFFER_SECONDS,
  DISPATCH_WINDOW_MS,
  DRIVER_EVENTS,
  MIN_OFFER_SHOW_MS,
  REQUEST_GONE_TOAST,
  isOfferLive,
  nextOffer,
  offerDeadline,
  type OfferClosedPayload,
  type OfferClosedReason,
  type RequestGoneReason,
} from "@rida/shared";
import { getRideSocket, type EligibleRideItem } from "@rida/mobile-shared";
import { alertNewOffer } from "./offerAlert";
import { runRejectOffer } from "./tripActions";

/** An eligible request with the times the queue needs (servers before offers don't send them). */
export type OfferItem = EligibleRideItem & { expiresAt: string; pickupDistanceMeters: number | null };

export interface ShownOffer {
  item: OfferItem;
  /** When the countdown started and ends (epoch ms). */
  shownAt: number;
  deadline: number;
  /**
   * When the driver tapped Accept (epoch ms), or undefined. From then on the
   * offer stays up until the claim's answer closes it: its countdown stops
   * where it was and it can't time out underneath the spinner or an error.
   */
  heldAt?: number;
}

/** Why an offer that was showing went away, in words for a toast. */
const GONE_NOTICE: Record<OfferClosedReason, string> = REQUEST_GONE_TOAST;

/**
 * Offers this driver has dealt with this session — accepted, declined,
 * timed out, or seen withdrawn. Kept outside the screen so leaving Home and
 * coming back never brings one back. (The server never re-offers a declined
 * or timed-out ride either; this just makes it instant.)
 */
const handled = new Set<string>();

export function asOfferItem(r: EligibleRideItem): OfferItem {
  return {
    ...r,
    expiresAt: r.expiresAt ?? new Date(Date.parse(r.createdAt) + DISPATCH_WINDOW_MS).toISOString(),
    pickupDistanceMeters: r.pickupDistanceMeters ?? null,
  };
}

/**
 * The offer pop-up's queue (Bolt/Uber style): ONE offer at a time, nearest
 * pickup first, with a countdown set by the server. Taken, cancelled or
 * expired requests leave the queue live — and if one is on screen, it
 * closes with a short note. Decline and timeout are recorded on the server
 * (never re-offered), Accept hands the request to `onAccept`.
 *
 * Coming back from the background: an offer whose countdown ran out while
 * the app was away closes as timed out, and nothing with under 4 s left is
 * ever shown — so no expired pop-up greets the driver.
 */
export function useOfferQueue({
  enabled,
  items,
  onAccept,
}: {
  /** Online, free, and on Home. */
  enabled: boolean;
  items: readonly EligibleRideItem[];
  onAccept: (item: EligibleRideItem) => void;
}) {
  const [current, setCurrent] = useState<ShownOffer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState<ReadonlyMap<string, OfferClosedReason>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const queue = useMemo(() => items.map(asOfferItem), [items]);

  // Withdrawn offers, the moment the server says so.
  useEffect(() => {
    if (!enabled) return;
    const socket = getRideSocket();
    const onClosed = (p: OfferClosedPayload) => setWithdrawn((m) => new Map(m).set(p.rideId, p.reason));
    socket.on(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
    return () => {
      socket.off(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
    };
  }, [enabled]);

  // Back from the background: re-check at once (the timers didn't run).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") setNow(Date.now());
    });
    return () => sub.remove();
  }, []);

  const close = useCallback((rideId: string, how: "accepted" | "declined" | "timedOut" | "gone", why?: string) => {
    handled.add(rideId);
    if (how === "declined") runRejectOffer(rideId, "DECLINED");
    if (how === "timedOut") runRejectOffer(rideId, "TIMED_OUT");
    setNotice(how === "gone" && why ? why : null);
    setCurrent((c) => (c?.item.rideId === rideId ? null : c));
  }, []);

  // Keep the offer on screen honest: gone from the list or withdrawn →
  // close with a note; countdown over → timed out. Not while it's held: the
  // claim's own answer closes it then.
  useEffect(() => {
    if (!current) return;
    if (!enabled) {
      setCurrent(null); // went offline / got a trip: not a decline
      return;
    }
    if (current.heldAt !== undefined) return;
    const state = isOfferLive(
      { rideId: current.item.rideId, deadline: current.deadline },
      queue,
      new Set(withdrawn.keys()),
      Date.now(),
    );
    if (state === "gone") {
      const reason = withdrawn.get(current.item.rideId);
      close(current.item.rideId, "gone", reason ? GONE_NOTICE[reason] : "That request is no longer available");
    } else if (state === "timedOut") {
      close(current.item.rideId, "timedOut");
    } else {
      const t = setTimeout(() => setNow(Date.now()), Math.max(0, current.deadline - Date.now()) + 50);
      return () => clearTimeout(t);
    }
  }, [current, enabled, queue, withdrawn, now, close]);

  // Nothing on screen: pop up the next one.
  useEffect(() => {
    if (!enabled || current) return;
    const t = Date.now();
    const exclude = new Set([...handled, ...withdrawn.keys()]);
    const next = nextOffer(queue, exclude, t);
    if (!next) return;
    setCurrent({
      item: next,
      shownAt: t,
      deadline: offerDeadline(t, next.offerSeconds ?? DEFAULT_OFFER_SECONDS, next.expiresAt),
    });
    alertNewOffer();
  }, [enabled, current, queue, withdrawn, now]);

  // A note fades after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3_500);
    return () => clearTimeout(t);
  }, [notice]);

  const waiting = useMemo(() => {
    const t = Date.now();
    return queue.filter(
      (o) =>
        o.rideId !== current?.item.rideId &&
        !handled.has(o.rideId) &&
        !withdrawn.has(o.rideId) &&
        Date.parse(o.expiresAt) - t >= MIN_OFFER_SHOW_MS,
    ).length;
    // `now` re-runs it as time passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, current, withdrawn, now]);

  return {
    offer: current,
    /** How many more offers are lined up behind this one. */
    waiting,
    /** "That request was taken" etc., for a moment after an offer went away. */
    notice,
    /** Accept tapped: the offer is held (see ShownOffer.heldAt) and handed to `onAccept`. */
    accept: () => {
      if (!current) return;
      const item = current.item;
      if (current.heldAt === undefined) setCurrent({ ...current, heldAt: Date.now() });
      onAccept(item);
    },
    /** The claim said the request is gone: close it with that toast (nothing to decline). */
    closeGone: (rideId: string, reason: RequestGoneReason) => close(rideId, "gone", GONE_NOTICE[reason]),
    decline: () => current && close(current.item.rideId, "declined"),
    /** For an offer handled elsewhere (accepted from the Home list). */
    markHandled: (rideId: string) => close(rideId, "accepted"),
  };
}
