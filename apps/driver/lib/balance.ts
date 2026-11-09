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

/** How often "Waiting for payment…" asks the server (which asks Paystack). */
const POLL_MS = 4_000;

/**
 * Paying the whole balance: start it, then wait. While the payment is
 * unfinished the server is asked every few seconds (only while the app is
 * in front, and again the moment it comes back, e.g. from Paystack's page
 * in the browser). The app never decides a payment is paid: only the
 * server's answer, which only Paystack's verify endpoint can change, does.
 */
export function useCommissionPayment(resume: CommissionPayment | null) {
  const queryClient = useQueryClient();
  const [payment, setPayment] = useState<CommissionPayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumed = useRef<string | null>(null);

  // A payment still going when the screen opens (the app was closed meanwhile).
  useEffect(() => {
    if (resume && resumed.current !== resume.reference && !payment) {
      resumed.current = resume.reference;
      setPayment(resume);
    }
  }, [resume, payment]);

  const settle = useCallback(
    (next: CommissionPayment) => {
      setPayment(next);
      if (next.status !== "PENDING") void queryClient.invalidateQueries({ queryKey: driverBalanceQueryKey });
    },
    [queryClient],
  );

  const pending = payment?.status === "PENDING" ? payment.reference : null;
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const check = async () => {
      if (AppState.currentState !== "active") return;
      try {
        const next = await getCommissionPayment(pending);
        if (alive) settle(next);
      } catch {
        // A dropped check: the next one tries again.
      }
    };
    const timer = setInterval(() => void check(), POLL_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [pending, settle]);

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
    payMomo: (phone: string, network: MomoNetwork) => run(() => startCommissionPayment({ channel: "MOMO", phone, network })),
    payOnPaystackPage: () => run(() => startCommissionPayment({ channel: "CHECKOUT" })),
    sendCode: (otp: string) => (payment ? run(() => submitCommissionOtp(payment.reference, otp)) : Promise.resolve()),
    openPage: () => (payment?.checkoutUrl ? openCheckout(payment.checkoutUrl) : Promise.resolve()),
    /** Back to the form (a new payment replaces the unfinished one). */
    dismiss: () => {
      setPayment(null);
      setError(null);
    },
  };
}

/** Paystack's hosted checkout page, in the phone's browser. */
async function openCheckout(url: string): Promise<void> {
  if (!url.startsWith("https://")) return;
  await Linking.openURL(url).catch(() => undefined);
}
