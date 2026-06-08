/**
 * Amount conversion at the Moolre boundary ONLY. Our domain stores integer
 * pesewas (GHS 1 = 100 pesewas); Moolre's API uses decimal GHS strings
 * (e.g. "12.75"). Never let a float into domain logic — these helpers do
 * exact integer arithmetic and string formatting, no floating point math.
 */

/** Converts integer pesewas to a Moolre-style decimal GHS string, e.g. 1275 -> "12.75". */
export function pesewasToGhs(pesewas: number): string {
  if (!Number.isInteger(pesewas) || pesewas < 0) {
    throw new RangeError(`pesewasToGhs: expected a non-negative integer, got ${pesewas}`);
  }
  const whole = Math.floor(pesewas / 100);
  const fraction = pesewas % 100;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

/** Converts a Moolre-style decimal GHS string back to integer pesewas, e.g. "12.75" -> 1275. */
export function ghsToPesewas(ghs: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(ghs.trim());
  if (!match) {
    throw new RangeError(`ghsToPesewas: not a valid GHS amount string: ${JSON.stringify(ghs)}`);
  }
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return whole * 100 + Number(fraction);
}
