/**
 * Registrai `.ai` segment-index — computation + falsification diagnostics.
 *
 * Suffix Pool keystone (docs/.../suffix-pool-design.md §4, §18). The index
 * marks `.ai` domains by SEGMENT (length × structural type), drifting junior
 * ($aiLP) NAV only — it deliberately does NOT back the senior ($ai) floor, so
 * a thin/unreliable index is non-fatal. This module's primary job is to answer
 * the keystone question honestly: *is the `.ai` aftermarket dense enough, per
 * segment, to index with any fidelity?* The diagnostics quantify exactly that.
 *
 * Marking-relevant output is the PER-SEGMENT median (`Ĩ_seg`); the headline
 * `value` is the overall trimmed median (a coarse level). Type classification
 * is STRUCTURAL only (numeric / alphanumeric / alpha-by-length) — no wordlist,
 * so it's deterministic and testable. Dictionary-vs-brandable refinement is a
 * v2 item (needs an NLP/wordlist) and is noted in the methodology.
 */
import type { Hex } from "viem";
import { hashRecords, median } from "@registrai/agent-sdk";
import type { AiSale } from "../sources/ai-sales.js";

// A segment is "markable" when it has at least this many sales in the window.
// Reported at multiple thresholds so the sparsity is visible, not hidden.
const MARKABLE_MIN = 8;
const COVERAGE_THRESHOLDS = [5, 8, 15] as const;
// The index is only honestly attestable if this fraction of SALES falls in
// coarse (length-only) segments that clear MARKABLE_MIN.
const MIN_ATTESTABLE_COVERAGE = 0.6;

export type LengthClass = "1" | "2" | "3" | "4" | "5" | "6-7" | "8-12" | "13+";
export type TypeClass = "numeric" | "alphanumeric" | "alpha";

export function sld(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.ai$/, "");
}

export function lengthClass(s: string): LengthClass {
  const n = s.length;
  if (n <= 1) return "1";
  if (n <= 5) return String(n) as LengthClass;
  if (n <= 7) return "6-7";
  if (n <= 12) return "8-12";
  return "13+";
}

export function typeClass(s: string): TypeClass {
  if (/^\d+$/.test(s)) return "numeric";
  if (/\d/.test(s)) return "alphanumeric";
  return "alpha";
}

function mad(values: readonly number[], med: number): number {
  if (values.length === 0) return 0;
  return median(values.map((v) => Math.abs(v - med)));
}

export interface BucketStat {
  key: string;
  n: number;
  medianUsd: number;
  /** Relative dispersion = MAD / median. >~0.5 means the segment is too noisy to mark. */
  relDispersion: number;
  markable: boolean;
}

export interface YoYStat {
  segment: string;
  fromYear: number;
  toYear: number;
  fromMedian: number;
  toMedian: number;
  pctChange: number;
}

export interface AiIndexContext {
  windowSales: number;
  /** Coarse buckets: by length only. */
  byLength: BucketStat[];
  /** Fine buckets: length × type. Sparsity explodes here. */
  byLengthType: BucketStat[];
  coverage: {
    /** Fraction of SALES in coarse segments clearing each threshold. */
    coarseSalesCoveredAt: Record<number, number>;
    /** Fraction of coarse buckets that are markable at MARKABLE_MIN. */
    coarseBucketsMarkable: number;
    /** Fraction of fine buckets that are markable at MARKABLE_MIN. */
    fineBucketsMarkable: number;
  };
  /** Year-over-year median moves on segments dense enough in BOTH years — the
   *  signal you'd actually drift marks by. Sparse/empty ⇒ index can't drift. */
  yoy: YoYStat[];
  verdict: {
    attestable: boolean;
    reason: string;
  };
}

export interface AiIndexResult {
  /** Headline level: overall trimmed median sale price, USD (coarse). */
  value: number;
  inputHash: Hex;
  /** Per-segment median (Ĩ_seg) — the marking-relevant vector. key → USD. */
  segmentMedians: Record<string, number>;
  context: AiIndexContext;
}

function bucketStats<T extends AiSale>(
  sales: readonly T[],
  keyOf: (s: T) => string,
  minMarkable: number,
): BucketStat[] {
  const groups = new Map<string, number[]>();
  for (const s of sales) {
    const k = keyOf(s);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s.priceUsd);
  }
  const out: BucketStat[] = [];
  for (const [key, prices] of groups) {
    const med = median(prices);
    out.push({
      key,
      n: prices.length,
      medianUsd: med,
      relDispersion: med > 0 ? mad(prices, med) / med : 0,
      markable: prices.length >= minMarkable,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

/**
 * Compute the `.ai` segment index + full falsification diagnostics. Pure.
 * Never throws on sparse data — it REPORTS sparsity via `context.verdict`.
 * Use assertAttestable() in the agent path to refuse a dishonest attestation.
 */
export function computeAiIndex(sales: readonly AiSale[]): AiIndexResult {
  if (sales.length === 0) throw new Error("computeAiIndex: no sales");

  const withSld = sales.map((s) => ({ ...s, _sld: sld(s.domain) }));
  const coarseKey = (s: AiSale & { _sld: string }) => lengthClass(s._sld);
  const fineKey = (s: AiSale & { _sld: string }) =>
    `${lengthClass(s._sld)}·${typeClass(s._sld)}`;

  const byLength = bucketStats(withSld, coarseKey, MARKABLE_MIN);
  const byLengthType = bucketStats(withSld, fineKey, MARKABLE_MIN);

  // Coverage: fraction of sales sitting in coarse buckets that clear a threshold.
  const coarseCounts = new Map<string, number>();
  for (const s of withSld) coarseCounts.set(coarseKey(s), (coarseCounts.get(coarseKey(s)) ?? 0) + 1);
  const coarseSalesCoveredAt: Record<number, number> = {};
  for (const t of COVERAGE_THRESHOLDS) {
    let covered = 0;
    for (const c of coarseCounts.values()) if (c >= t) covered += c;
    coarseSalesCoveredAt[t] = covered / withSld.length;
  }

  // YoY: per coarse segment, median move between consecutive years where BOTH
  // years have >= MARKABLE_MIN samples — i.e. a drift you could actually trust.
  const yoy: YoYStat[] = [];
  const byYearSeg = new Map<string, Map<number, number[]>>();
  for (const s of withSld) {
    const seg = coarseKey(s);
    const ym = byYearSeg.get(seg) ?? byYearSeg.set(seg, new Map()).get(seg)!;
    (ym.get(s.year) ?? ym.set(s.year, []).get(s.year)!).push(s.priceUsd);
  }
  for (const [seg, ym] of byYearSeg) {
    const years = [...ym.keys()].sort((a, b) => a - b);
    for (let i = 1; i < years.length; i++) {
      const a = ym.get(years[i - 1]!)!;
      const b = ym.get(years[i]!)!;
      if (a.length >= MARKABLE_MIN && b.length >= MARKABLE_MIN) {
        const fm = median(a), tm = median(b);
        yoy.push({ segment: seg, fromYear: years[i - 1]!, toYear: years[i]!, fromMedian: fm, toMedian: tm, pctChange: fm > 0 ? (tm - fm) / fm : 0 });
      }
    }
  }

  const coarseBucketsMarkable = byLength.filter((b) => b.markable).length / Math.max(1, byLength.length);
  const fineBucketsMarkable = byLengthType.filter((b) => b.markable).length / Math.max(1, byLengthType.length);

  const coverage60 = coarseSalesCoveredAt[MARKABLE_MIN] ?? 0;
  const attestable = coverage60 >= MIN_ATTESTABLE_COVERAGE && yoy.length > 0;
  const reason = attestable
    ? `coverage ${(coverage60 * 100).toFixed(0)}% ≥ ${(MIN_ATTESTABLE_COVERAGE * 100).toFixed(0)}% and ${yoy.length} driftable segment-years`
    : `coverage ${(coverage60 * 100).toFixed(0)}% (need ${(MIN_ATTESTABLE_COVERAGE * 100).toFixed(0)}%), driftable segment-years=${yoy.length}`;

  // Headline value: overall median (robust enough for a coarse level).
  const value = Math.round(median(withSld.map((s) => s.priceUsd)));

  const segmentMedians: Record<string, number> = {};
  for (const b of byLength) segmentMedians[b.key] = b.medianUsd;

  const inputHash = hashRecords(
    withSld.map((s) => ({ id: s.domain, value: s.priceUsd })),
    0,
    "ai-segment-index-v1",
  );

  return {
    value,
    inputHash,
    segmentMedians,
    context: {
      windowSales: withSld.length,
      byLength,
      byLengthType,
      coverage: { coarseSalesCoveredAt, coarseBucketsMarkable, fineBucketsMarkable },
      yoy,
      verdict: { attestable, reason },
    },
  };
}

/** Refuse to attest a dishonest index. Used in the agent run path. */
export function assertAttestable(r: AiIndexResult): void {
  if (!r.context.verdict.attestable) {
    throw new Error(`ai-index: refusing to attest — ${r.context.verdict.reason}`);
  }
}
