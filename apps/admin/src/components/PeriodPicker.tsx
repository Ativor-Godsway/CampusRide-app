import { useState } from "react";
import { PRESET_LABELS, customPeriod, presetPeriod, type Period, type PeriodPreset } from "../lib/period";

const DEFAULT_CHOICES: Exclude<PeriodPreset, "custom">[] = ["today", "yesterday", "this-week", "last-week", "this-month"];

/** Today / Yesterday / This week / Last week / This month / a custom range of days. */
export function PeriodPicker({
  value,
  onChange,
  choices = DEFAULT_CHOICES,
  allowCustom = true,
}: {
  value: Period;
  onChange: (p: Period) => void;
  choices?: Exclude<PeriodPreset, "custom">[];
  allowCustom?: boolean;
}) {
  const [custom, setCustom] = useState(value.preset === "custom");
  const [from, setFrom] = useState(value.from.toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date(value.to.getTime() - 1).toISOString().slice(0, 10));
  return (
    <div className="period-picker">
      <div className="segmented" role="group" aria-label="Period">
        {choices.map((c) => (
          <button
            key={c}
            type="button"
            className={value.preset === c && !custom ? "seg active" : "seg"}
            aria-pressed={value.preset === c && !custom}
            onClick={() => {
              setCustom(false);
              onChange(presetPeriod(c));
            }}
          >
            {PRESET_LABELS[c]}
          </button>
        ))}
        {allowCustom ? (
          <button type="button" className={custom ? "seg active" : "seg"} aria-pressed={custom} onClick={() => setCustom(true)}>
            Custom
          </button>
        ) : null}
      </div>
      {custom ? (
        <form
          className="custom-range"
          onSubmit={(e) => {
            e.preventDefault();
            const p = customPeriod(from, to);
            if (p) onChange(p);
          }}
        >
          <label>
            <span className="sr-only">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <span aria-hidden="true">to</span>
          <label>
            <span className="sr-only">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <button type="submit" className="tonal-button small" disabled={!customPeriod(from, to)}>
            Show
          </button>
        </form>
      ) : null}
    </div>
  );
}
