import { useMemo, useState, type ReactNode } from "react";
import { Empty, ErrorNote, Loading } from "./States";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Makes the column sortable by this value. */
  sortValue?: (row: T) => number | string | null;
  align?: "left" | "right";
  /** Left out of the stacked rows on a phone. */
  phoneHidden?: boolean;
}

export interface ServerPaging {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}

/**
 * The site's table: sticky header, sortable columns (click or Enter on the
 * header), a page at a time (here, or by the server with `paging`), and its
 * own loading, empty and error states. A row can open something
 * (`onRowClick`, keyboard too). On a phone each row becomes a stacked card.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  loading = false,
  error = null,
  onRetry,
  empty = "Nothing here yet.",
  pageSize = 25,
  paging,
  initialSort,
  caption,
}: {
  columns: Column<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** What a row opens, for screen readers ("Open ride by Ama O."). */
  rowLabel?: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: ReactNode;
  pageSize?: number;
  paging?: ServerPaging;
  initialSort?: { key: string; dir: "asc" | "desc" };
  caption?: string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (!rows || !sort) return rows ?? [];
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const order = x < y ? -1 : 1;
      return sort.dir === "asc" ? order : -order;
    });
  }, [rows, sort, columns]);

  if (rows === null) {
    if (error) return <ErrorNote message={error} onRetry={onRetry} />;
    return loading ? <Loading /> : null;
  }

  const pages = paging ? Math.max(1, Math.ceil(paging.total / paging.pageSize)) : Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = paging ? paging.page : Math.min(page, pages);
  const shown = paging ? sorted : sorted.slice((current - 1) * pageSize, current * pageSize);
  const go = (p: number) => (paging ? paging.onPage(p) : setPage(p));

  const toggle = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  return (
    <div className="table-block">
      {error ? <ErrorNote message={`Couldn't refresh: ${error}`} onRetry={onRetry} /> : null}
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            {caption ? <caption className="sr-only">{caption}</caption> : null}
            <thead>
              <tr>
                {columns.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className={`${c.align === "right" ? "right" : ""}${c.phoneHidden ? " phone-hidden" : ""}`}
                      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      {c.sortValue ? (
                        <button type="button" className="sort-button" onClick={() => toggle(c.key)}>
                          {c.header}
                          <span aria-hidden="true" className="sort-mark">
                            {active ? (sort!.dir === "asc" ? "\u25B2" : "\u25BC") : ""}
                          </span>
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={onRowClick ? "clickable" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((c) => (
                    <td key={c.key} data-label={c.header} className={`${c.align === "right" ? "right" : ""}${c.phoneHidden ? " phone-hidden" : ""}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="text-button" disabled={current <= 1} onClick={() => go(current - 1)}>
            Previous
          </button>
          <span className="num">
            Page {current} of {pages}
            {paging ? ` · ${paging.total} in all` : ` · ${rows.length} in all`}
          </span>
          <button type="button" className="text-button" disabled={current >= pages} onClick={() => go(current + 1)}>
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}
