import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * A detail panel: on the right on a desktop, full screen on a phone. Opened
 * by a query parameter (?ride=…), so it has its own URL and the browser's
 * back button closes it. Escape closes it too; focus moves into it and back
 * to where it was.
 */
export function DetailDrawer({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="drawer-layer">
      <button type="button" className="drawer-backdrop" aria-label="Close panel" tabIndex={-1} onClick={onClose} />
      <div ref={panel} className={`drawer${wide ? " drawer-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
