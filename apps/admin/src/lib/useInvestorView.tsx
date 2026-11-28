import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth";
import { readInvestorView, setInvestorMasking, writeInvestorView } from "./investor";

interface InvestorViewValue {
  on: boolean;
  toggle: () => void;
}

const InvestorViewContext = createContext<InvestorViewValue>({ on: false, toggle: () => {} });

/**
 * Investor view on/off for this admin session (lib/investor.ts does the
 * masking). Switching it remounts the pages (App keys them on it), so every
 * page fetches again, masked or not.
 */
export function InvestorViewProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const sessionKey = session ? (session.sessionExpiresAt ?? session.user.id) : "";
  const [on, setOn] = useState(() => {
    const value = sessionKey ? readInvestorView(sessionKey) : false;
    setInvestorMasking(value);
    return value;
  });
  const toggle = useCallback(() => {
    setOn((was) => {
      const next = !was;
      setInvestorMasking(next);
      writeInvestorView(sessionKey, next);
      return next;
    });
  }, [sessionKey]);
  const value = useMemo(() => ({ on, toggle }), [on, toggle]);
  return <InvestorViewContext.Provider value={value}>{children}</InvestorViewContext.Provider>;
}

export function useInvestorView(): InvestorViewValue {
  return useContext(InvestorViewContext);
}
