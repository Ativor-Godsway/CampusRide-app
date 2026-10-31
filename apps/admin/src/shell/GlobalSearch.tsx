import { useEffect, useRef, useState } from "react";
import { search, type SearchResult } from "../api";
import { useToken } from "../auth";
import { Icon } from "../components/Icon";
import { useRouter } from "../lib/router";

/** Where a search result opens. */
export function resultUrl(r: SearchResult): string {
  if (r.kind === "ride") return `/rides?ride=${encodeURIComponent(r.id)}`;
  if (r.kind === "driver") return `/drivers?driver=${encodeURIComponent(r.id)}`;
  return `/riders?rider=${encodeURIComponent(r.id)}`;
}

/**
 * The top bar's search: a phone number, a ride id, or a driver's name or
 * plate. Enter (or a click) jumps to the first match's detail; arrows move
 * through the list. Asks the server only after a short pause in typing.
 */
export function GlobalSearch() {
  const token = useToken();
  const { navigate } = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const t = window.setTimeout(() => {
      search(token, term).then(
        (r) => {
          setResults(r.results);
          setActive(0);
        },
        () => setResults([]),
      );
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, token]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const go = (r: SearchResult) => {
    navigate(resultUrl(r));
    setOpen(false);
    setQ("");
  };

  return (
    <div className="search" ref={box}>
      <label className="search-field">
        <Icon name="search" size={16} />
        <span className="sr-only">Search by phone, ride ID, driver name or plate</span>
        <input
          type="search"
          value={q}
          placeholder="Search phone, ride, driver"
          role="combobox"
          aria-expanded={open && results !== null}
          aria-controls="search-results"
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!results?.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(results[active]!);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
      </label>
      {open && results !== null ? (
        <ul id="search-results" className="search-results" role="listbox">
          {results.length === 0 ? (
            <li className="muted search-empty">Nothing matches “{q.trim()}”.</li>
          ) : (
            results.map((r, i) => (
              <li key={`${r.kind}:${r.id}`} role="option" aria-selected={i === active}>
                <button type="button" className={i === active ? "active" : undefined} onMouseEnter={() => setActive(i)} onClick={() => go(r)}>
                  <strong>{r.title}</strong>
                  <span className="muted">{r.subtitle}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
