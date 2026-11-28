import type { ReactNode } from "react";

/** Loading, empty and error states, the same everywhere. Loading is a skeleton of grey bars (the words are for screen readers). */
export function Loading({ what = "Loading…", rows = 4 }: { what?: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{what}</span>
      <div className="skeleton-row" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skeleton-bar tall" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-bar" style={{ width: `${92 - i * 9}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="text-button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * The usual three-way switch for a block that loads: the error (with the
 * last data still shown under it when there is some), loading, or content.
 */
export function Loaded<T>({
  data,
  error,
  loading,
  onRetry,
  children,
  what,
}: {
  data: T | null;
  error: string | null;
  loading: boolean;
  onRetry?: () => void;
  what?: string;
  children: (data: T) => ReactNode;
}) {
  if (data === null) {
    if (error) return <ErrorNote message={error} onRetry={onRetry} />;
    if (loading) return <Loading what={what} />;
    return null;
  }
  return (
    <>
      {error ? <ErrorNote message={`Couldn't refresh: ${error}. Showing what was loaded before.`} onRetry={onRetry} /> : null}
      {children(data)}
    </>
  );
}
