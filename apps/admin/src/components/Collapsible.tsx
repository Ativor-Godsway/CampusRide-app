import { useId, useState, type ReactNode } from "react";
import { readPref, writePref } from "../lib/storage";
import { Icon } from "./Icon";

/**
 * A section that opens and closes (closed by default), with a title, a
 * one-line explanation of what is inside, and an optional figure on the
 * right. Whether it is open is remembered per `id` in this browser.
 */
export function Collapsible({
  id,
  title,
  hint,
  aside,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  aside?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `open.${id}`;
  const [open, setOpen] = useState(() => {
    const saved = readPref(key);
    return saved === null ? defaultOpen : saved === "1";
  });
  const bodyId = useId();
  return (
    <section className={`collapsible${open ? " open" : ""}`}>
      <button
        type="button"
        className="collapsible-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setOpen((o) => {
            writePref(key, o ? "0" : "1");
            return !o;
          });
        }}
      >
        <span className="collapsible-titles">
          <span className="collapsible-title">{title}</span>
          {hint ? <span className="collapsible-hint">{hint}</span> : null}
        </span>
        {aside ? <span className="collapsible-aside">{aside}</span> : null}
        <Icon name="chevron" size={16} className="collapsible-chevron" />
      </button>
      <div className="collapsible-body" id={bodyId} aria-hidden={!open}>
        <div className="collapsible-inner">{open ? children : null}</div>
      </div>
    </section>
  );
}
