import { useCallback, useMemo } from "react";
import { periodFromSearch, periodToSearch, presetPeriod, type Period, type PeriodPreset } from "./period";
import { useRouter } from "./router";
import { readPref, writePref } from "./storage";

/**
 * A page's period: from the URL (so a link opens the same view), else the
 * last one chosen on this page in this browser, else the page's default.
 */
export function usePagePeriod(page: string, fallback: Exclude<PeriodPreset, "custom">): [Period, (p: Period) => void] {
  const { search, setParams } = useRouter();
  const raw = search.toString();
  const period = useMemo(() => {
    const fromUrl = periodFromSearch(new URLSearchParams(raw));
    if (fromUrl) return fromUrl;
    const remembered = readPref(`period.${page}`);
    if (remembered) {
      const p = periodFromSearch(new URLSearchParams(remembered));
      if (p) return p;
    }
    return presetPeriod(fallback);
  }, [raw, page, fallback]);

  const setPeriod = useCallback(
    (p: Period) => {
      const params = periodToSearch(p);
      writePref(`period.${page}`, new URLSearchParams(params).toString());
      setParams({ period: null, from: null, to: null, page: null, ...params }, { replace: true });
    },
    [page, setParams],
  );
  return [period, setPeriod];
}
