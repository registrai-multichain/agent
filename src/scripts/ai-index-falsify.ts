/**
 * Keystone falsification test for the Suffix Pool: can the `.ai` aftermarket
 * be indexed by segment with enough fidelity to be useful?
 *
 * Run: `npx tsx src/scripts/ai-index-falsify.ts`
 *
 * Prints per-segment density, dispersion, coverage, and year-over-year drift
 * signal off the best PUBLIC `.ai` sales data. If even the public top of the
 * market can't clear coverage, a treasury's long-tail holdings certainly can't
 * be honestly index-marked — which (per spec v2) is fine for the FLOOR (it
 * doesn't use the index) and tells us the index is junior-upside signal at best.
 */
import { fetchAiSales } from "../sources/ai-sales.js";
import { computeAiIndex } from "../agents/ai-index.js";

function usd(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}
function pct(n: number): string {
  return (n * 100).toFixed(0) + "%";
}

async function main() {
  const sales = await fetchAiSales();
  const r = computeAiIndex(sales);
  const c = r.context;

  console.log("\n=== .ai segment-index — falsification report ===");
  console.log(`sales in window: ${c.windowSales} (public reported sales)`);
  console.log(`headline level (overall median): ${usd(r.value)}\n`);

  console.log("by length (coarse segment — the markable unit):");
  console.log("  seg     n   median        relDisp  markable");
  for (const b of c.byLength) {
    console.log(
      `  ${b.key.padEnd(6)} ${String(b.n).padStart(2)}   ${usd(b.medianUsd).padEnd(11)}  ${b.relDispersion.toFixed(2).padStart(5)}    ${b.markable ? "yes" : "—"}`,
    );
  }

  console.log("\nby length × type (fine segment — note the sparsity blow-up):");
  console.log("  seg            n   median       markable");
  for (const b of c.byLengthType) {
    console.log(
      `  ${b.key.padEnd(13)} ${String(b.n).padStart(2)}   ${usd(b.medianUsd).padEnd(11)} ${b.markable ? "yes" : "—"}`,
    );
  }

  console.log("\ncoverage (fraction of sales in coarse segments clearing N):");
  for (const [t, frac] of Object.entries(c.coverage.coarseSalesCoveredAt)) {
    console.log(`  N≥${t}: ${pct(frac)}`);
  }
  console.log(`  coarse buckets markable: ${pct(c.coverage.coarseBucketsMarkable)}`);
  console.log(`  fine buckets markable:   ${pct(c.coverage.fineBucketsMarkable)}`);

  console.log("\nyear-over-year drift on segments dense in BOTH years (the signal");
  console.log("you'd actually move marks by):");
  if (c.yoy.length === 0) {
    console.log("  NONE — no coarse segment has ≥8 sales in two consecutive years.");
    console.log("  → the index has no trustworthy drift signal at this density.");
  } else {
    for (const y of c.yoy) {
      console.log(`  ${y.segment}: ${y.fromYear}→${y.toYear}  ${usd(y.fromMedian)}→${usd(y.toMedian)}  (${(y.pctChange * 100).toFixed(0)}%)`);
    }
  }

  console.log(`\nVERDICT: ${c.verdict.attestable ? "ATTESTABLE" : "NOT ATTESTABLE"} — ${c.verdict.reason}`);
  console.log("\ninterpretation:");
  console.log("  • If NOT attestable on the public TOP of the market, the long");
  console.log("    tail a treasury holds is far worse → index is junior-upside");
  console.log("    signal only, never floor backing (spec v2 §2,§4).");
  console.log("  • The senior $ai floor is unaffected — it never reads this index.\n");
}

void main();
