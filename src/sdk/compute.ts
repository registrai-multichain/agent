/**
 * Generic statistical helpers. Pure functions, no I/O.
 */
import { keccak256, toHex } from "viem";

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median: empty input");
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/**
 * Drop the top `pct` and bottom `pct` of values (each side), by the
 * supplied numeric accessor. Returns the retained subset and the count
 * of dropped entries.
 */
export function trimByPercentile<T>(
  values: readonly T[],
  pct: number,
  by: (v: T) => number,
): { retained: T[]; dropped: number } {
  const sorted = [...values].sort((a, b) => by(a) - by(b));
  const cut = Math.floor(sorted.length * pct);
  const retained = sorted.slice(cut, sorted.length - cut);
  return { retained, dropped: sorted.length - retained.length };
}

/**
 * Deterministic input hash for a sorted set of records, optionally with a
 * tail string (used to commit extra context like an NBP report version).
 *
 * The shape of each record is `${id}:${value}` where `value` is a number
 * formatted to a fixed number of decimals — this prevents floating-point
 * jitter from changing the hash when the underlying data hasn't changed.
 */
export function hashRecords(
  records: ReadonlyArray<{ id: string; value: number }>,
  decimals = 2,
  tail = "",
): `0x${string}` {
  const sorted = [...records].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const parts = sorted.map((r) => `${r.id}:${r.value.toFixed(decimals)}`);
  const payload = tail ? `${parts.join("|")};${tail}` : parts.join("|");
  return keccak256(toHex(payload));
}
