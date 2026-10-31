import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Show = (message: string, tone?: "good" | "bad") => void;

const ToastContext = createContext<Show>(() => {});

/** One short message at the bottom of the screen ("Payment recorded"), gone after 4 s; read out by screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string; tone: "good" | "bad" } | null>(null);
  const show = useCallback<Show>((message, tone = "good") => {
    const id = Date.now();
    setToast({ id, message, tone });
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast ? <div className={`toast toast-${toast.tone}`}>{toast.message}</div> : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Show {
  return useContext(ToastContext);
}
