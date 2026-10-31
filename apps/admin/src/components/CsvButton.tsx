import { useState } from "react";
import { ApiError } from "../api";
import { downloadCsv, toCsv, type CsvCell } from "../lib/csv";
import { Icon } from "./Icon";
import { useToast } from "./Toast";

/** "Download CSV": builds the file from `rows()` (which may fetch) and saves it. */
export function CsvButton({ filename, header, rows, label = "Download CSV" }: { filename: string; header: string[]; rows: () => Promise<CsvCell[][]> | CsvCell[][]; label?: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className="text-button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const data = await rows();
          downloadCsv(filename, toCsv(header, data));
        } catch (err) {
          toast(err instanceof ApiError ? err.message : "The download failed", "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="download" size={16} />
      {busy ? "Preparing…" : label}
    </button>
  );
}
