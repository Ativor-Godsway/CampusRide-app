import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MomoNetwork } from "@rida/shared";
import {
  errorMessage,
  getCommissionPayment,
  getDriverBalance,
  startCommissionPayment,
  submitCommissionOtp,
  useAuth,
  type CommissionPayment,
} from "@rida/mobile-shared";

/** The driver's commission balance (Balance screen, Home's warning, Earnings). */
export const driverBalanceQueryKey = ["driverBalance"];

export function useDriverBalance() {
  const { user } = useAuth();
  return useQuery({
    queryKey: driverBalanceQueryKey,
    queryFn: getDriverBalance,
    enabled: user?.role === "DRIVER",
    staleTime: 30_000,
  });
}

/** How often "Waiting for payment…" asks the server (which asks Paystack at most every 10 s). */
const POLL_MS = 4_000;
/** Still waiting after this long: "Didn't get the prompt?" with Check again / Start over. */
export const SLOW_PAYMENT_MS = 2 * 60_000;

/**
 * Paying the whole balance: start it, then wait. While the payment is
 * unfinished the server is asked every few seconds (only while the app is
 * in front, and again the moment it comes back, e.g. from Paystack's page
 * in the browser). The app never decides a payment is paid: only the
 * server's answer, which only Paystack's verify endpoint can change, does.
 *
 * - SUCCESS: kept (the screen says "Paid ✓"), and the balance is fetched again.
 * - FAILED / MISMATCH: kept, so the screen can say why.
 * - ABANDONED (replaced, expired, or the balance was paid or waived some
 *   other way meanwhile): dropped, so the screen just shows the new balance.
 */
export function useCommissionPayment(resume: CommissionPayment | null) {
  const queryClient = useQueryClient();
  const [payment, setPayment] = useState<CommissionPayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When this phone started waiting for the current payment (epoch ms). */
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const resumed = useRef<string | null>(null);
  /** The payment on screen; an answer for any other (after Start over) is dropped. */
  const current = useRef<string | null>(null);

  const settle = useCallback(
    (next: CommissionPayment) => {
      if (next.status !== "PENDING") void queryClient.invalidateQueries({ queryKey: driverBalanceQueryKey });
      if (next.status === "ABANDONED") {
        current.current = null;
        setPayment(null);
        return;
      }
      if (next.status === "PENDING" && current.current !== next.reference) {
        // A payment resumed from the server has been going since it started; a new one, from now.
        const started = Date.parse(next.createdAt);
        setWaitingSince(Number.isFinite(started) ? Math.min(started, Date.now()) : Date.now());
      }
      current.current = next.reference;
      setPayment(next);
    },
    [queryClient],
  );

  // A payment still going when the screen opens (the app was closed meanwhile).
  useEffect(() => {
    if (resume && resumed.current !== resume.reference && !payment) {
      resumed.current = resume.reference;
      settle(resume);
    }
  }, [resume, payment, settle]);

  const pending = payment?.status === "PENDING" ? payment.reference : null;

  const check = useCallback(async () => {
    if (!pending) return;
    try {
      const next = await getCommissionPayment(pending);
      if (current.current === pending) settle(next);
    } catch {
      // A dropped check: the next one tries again.
    }
  }, [pending, settle]);

  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const tick = () => {
      if (alive && AppState.currentState === "active") void check();
    };
    const timer = setInterval(tick, POLL_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") tick();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [pending, check]);

  // "Didn't get the prompt?" once it has been waiting a while.
  useEffect(() => {
    if (!pending || waitingSince === null) {
      setSlow(false);
      return;
    }
    const left = waitingSince + SLOW_PAYMENT_MS - Date.now();
    if (left <= 0) {
      setSlow(true);
      return;
    }
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), left);
    return () => clearTimeout(timer);
  }, [pending, waitingSince]);

  const run = useCallback(
    async (action: () => Promise<CommissionPayment>) => {
      setBusy(true);
      setError(null);
      try {
        const next = await action();
        settle(next);
        if (next.status === "PENDING" && next.checkoutUrl) await openCheckout(next.checkoutUrl);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [settle],
  );

  return {
    payment,
    busy,
    error,
    /** Still waiting after SLOW_PAYMENT_MS. */
    slow,
    checking,
    payMomo: (phone: string, network: MomoNetwork) => run(() => startCommissionPayment({ channel: "MOMO", phone, network })),
    payOnPaystackPage: () => run(() => startCommissionPayment({ channel: "CHECKOUT" })),
    sendCode: (otp: string) => (payment ? run(() => submitCommissionOtp(payment.reference, otp)) : Promise.resolve()),
    openPage: () => (payment?.checkoutUrl ? openCheckout(payment.checkoutUrl) : Promise.resolve()),
    /** Ask now, instead of waiting for the next check. */
    checkAgain: async () => {
      setChecking(true);
      await check();
      setChecking(false);
    },
    /** Back to the form (a new payment replaces the unfinished one). */
    dismiss: () => {
      current.current = null;
      setPayment(null);
      setError(null);
      setWaitingSince(null);
    },
  };
}

/** Paystack's hosted checkout page, in the phone's browser. */
async function openCheckout(url: string): Promise<void> {
  if (!url.startsWith("https://")) return;
  await Linking.openURL(url).catch(() => undefined);
}
