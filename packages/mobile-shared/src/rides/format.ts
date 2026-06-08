/** Formats an integer-pesewas amount as a GHS string, e.g. 1000 -> "GHS 10". */
export function formatGhs(pesewas: number): string {
  const ghs = pesewas / 100;
  return `GHS ${ghs % 1 === 0 ? ghs.toFixed(0) : ghs.toFixed(2)}`;
}
