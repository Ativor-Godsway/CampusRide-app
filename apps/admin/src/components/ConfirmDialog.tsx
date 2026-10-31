import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A confirm box (a real <dialog>-like modal). With `reasonLabel` it asks for
 * a reason first and won't confirm without one. `danger` makes the confirm
 * button red text, as the design system says for destructive actions.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = false,
  reasonLabel,
  reasonPlaceholder,
  busy = false,
  error,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  danger?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  busy?: boolean;
  error?: string | null;
}) {
  const [reason, setReason] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>("textarea, input, button");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);
  const needsReason = Boolean(reasonLabel);
  return (
    <div className="modal-layer">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" ref={box}>
        <h2 id="confirm-title">{title}</h2>
        {children ? <div className="modal-text">{children}</div> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (needsReason && !reason.trim()) return;
            onConfirm(reason.trim());
          }}
        >
          {needsReason ? (
            <label className="field">
              <span>{reasonLabel}</span>
              <textarea rows={3} value={reason} maxLength={500} placeholder={reasonPlaceholder} onChange={(e) => setReason(e.target.value)} required />
            </label>
          ) : null}
          {error ? <p className="error-text" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={danger ? "danger-button" : "primary-button"} disabled={busy || (needsReason && !reason.trim())}>
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
