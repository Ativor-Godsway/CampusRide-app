import { createContext, useContext } from "react";
import type { Summary } from "../api";

export interface ShellValue {
  summary: Summary | null;
  /** Re-reads the badges now (after an action that changes one). */
  refreshSummary: () => void;
}

export const ShellContext = createContext<ShellValue>({ summary: null, refreshSummary: () => {} });

export function useShell(): ShellValue {
  return useContext(ShellContext);
}
