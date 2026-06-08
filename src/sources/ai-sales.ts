/**
 * `.ai` aftermarket sales — data source for the Registrai `.ai` segment-index
 * feed (Suffix Pool keystone; see docs/.../suffix-pool-design.md §4, §18).
 *
 * KEYSTONE CAVEAT: the `.ai` aftermarket is sparse, private, and self-reported.
 * Public data captures mostly *top* sales (premium short / dictionary names),
 * not the long tail a treasury actually holds. This module exists to let
 * computeAiIndex quantify that sparsity honestly — it is a *falsification test*
 * of whether the segment can be indexed with enough fidelity to be useful.
 *
 * PRODUCTION sources (pluggable via fetchAiSales): NameBio API (paid; the
 * canonical aggregator), dnjournal weekly reports, and — the trustless path —
 * on-chain Doma `.ai` trades once inventory exists. v1 ships the embedded
 * REPORTED_AI_SALES sample (real public sales) so the diagnostics run offline
 * and deterministically.
 */

export interface AiSale {
  /** Full domain, e.g. "bot.ai". */
  domain: string;
  /** Sale price in USD. */
  priceUsd: number;
  /** Calendar year of sale (coarse — public reports rarely give exact dates). */
  year: number;
  /** Where the sale was reported. */
  source: string;
}

/**
 * Real, publicly-reported `.ai` sales. Curated from public aggregators
 * (NameBio top-100 lists, cognitive.ai's reported `.ai` table, DNJournal).
 * This is the PUBLIC top of the market — deliberately so, because the whole
 * point of the diagnostics is to show how thin and top-skewed even the *best*
 * public coverage is. Prices are nominal as reported.
 *
 * Source: cognitive.ai/dotaisales.html + NameBio (retrieved 2026-06-06).
 */
export const REPORTED_AI_SALES: readonly AiSale[] = [
  { domain: "bot.ai", priceUsd: 1_200_000, year: 2026, source: "namebio" },
  { domain: "fin.ai", priceUsd: 1_000_000, year: 2025, source: "namebio" },
  { domain: "home.ai", priceUsd: 800_000, year: 2025, source: "namebio" },
  { domain: "omni.ai", priceUsd: 750_000, year: 2026, source: "namebio" },
  { domain: "wisdom.ai", priceUsd: 750_000, year: 2025, source: "namebio" },
  { domain: "you.ai", priceUsd: 700_000, year: 2023, source: "namebio" },
  { domain: "cloud.ai", priceUsd: 600_000, year: 2025, source: "namebio" },
  { domain: "let.ai", priceUsd: 515_000, year: 2025, source: "namebio" },
  { domain: "qwen.ai", priceUsd: 500_000, year: 2025, source: "namebio" },
  { domain: "genesis.ai", priceUsd: 400_000, year: 2026, source: "namebio" },
  { domain: "lotus.ai", priceUsd: 400_000, year: 2025, source: "namebio" },
  { domain: "z.ai", priceUsd: 360_000, year: 2024, source: "namebio" },
  { domain: "free.ai", priceUsd: 350_000, year: 2026, source: "namebio" },
  { domain: "law.ai", priceUsd: 350_000, year: 2025, source: "namebio" },
  { domain: "adapt.ai", priceUsd: 300_000, year: 2025, source: "namebio" },
  { domain: "use.ai", priceUsd: 300_000, year: 2025, source: "namebio" },
  { domain: "rush.ai", priceUsd: 300_000, year: 2025, source: "namebio" },
  { domain: "neo.ai", priceUsd: 275_000, year: 2026, source: "namebio" },
  { domain: "girlfriend.ai", priceUsd: 275_000, year: 2024, source: "namebio" },
  { domain: "stack.ai", priceUsd: 258_888, year: 2023, source: "namebio" },
  { domain: "npc.ai", priceUsd: 250_000, year: 2023, source: "namebio" },
  { domain: "sound.ai", priceUsd: 250_000, year: 2024, source: "namebio" },
  { domain: "boyfriend.ai", priceUsd: 230_000, year: 2024, source: "namebio" },
  { domain: "breeze.ai", priceUsd: 225_000, year: 2025, source: "namebio" },
  { domain: "seed.ai", priceUsd: 225_000, year: 2025, source: "namebio" },
  { domain: "sim.ai", priceUsd: 220_000, year: 2025, source: "namebio" },
  { domain: "ace.ai", priceUsd: 205_000, year: 2025, source: "namebio" },
  { domain: "rank.ai", priceUsd: 200_000, year: 2025, source: "namebio" },
  { domain: "zip.ai", priceUsd: 200_000, year: 2025, source: "namebio" },
  { domain: "please.ai", priceUsd: 200_000, year: 2024, source: "namebio" },
  { domain: "terafab.ai", priceUsd: 174_000, year: 2026, source: "namebio" },
  { domain: "partner.ai", priceUsd: 170_000, year: 2024, source: "namebio" },
  { domain: "turbo.ai", priceUsd: 165_000, year: 2025, source: "namebio" },
  { domain: "flourish.ai", priceUsd: 165_000, year: 2026, source: "namebio" },
  { domain: "speed.ai", priceUsd: 165_000, year: 2025, source: "namebio" },
  { domain: "vesta.ai", priceUsd: 160_000, year: 2026, source: "namebio" },
  { domain: "leo.ai", priceUsd: 150_000, year: 2025, source: "namebio" },
  { domain: "capital.ai", priceUsd: 150_000, year: 2025, source: "namebio" },
  { domain: "os.ai", priceUsd: 150_000, year: 2025, source: "namebio" },
  { domain: "easy.ai", priceUsd: 150_000, year: 2024, source: "namebio" },
  { domain: "weather.ai", priceUsd: 150_000, year: 2025, source: "namebio" },
  { domain: "aster.ai", priceUsd: 142_500, year: 2026, source: "namebio" },
  { domain: "golf.ai", priceUsd: 140_000, year: 2024, source: "namebio" },
  { domain: "fragment.ai", priceUsd: 135_000, year: 2026, source: "namebio" },
  { domain: "blueprint.ai", priceUsd: 130_000, year: 2024, source: "namebio" },
  { domain: "intuitive.ai", priceUsd: 125_000, year: 2025, source: "namebio" },
  { domain: "bind.ai", priceUsd: 120_000, year: 2025, source: "namebio" },
  { domain: "demand.ai", priceUsd: 118_000, year: 2025, source: "namebio" },
  { domain: "amber.ai", priceUsd: 115_000, year: 2026, source: "namebio" },
  { domain: "mini.ai", priceUsd: 115_000, year: 2025, source: "namebio" },
  { domain: "pioneer.ai", priceUsd: 111_000, year: 2025, source: "namebio" },
  { domain: "guild.ai", priceUsd: 110_000, year: 2025, source: "namebio" },
  { domain: "cognition.ai", priceUsd: 110_000, year: 2024, source: "namebio" },
  { domain: "odds.ai", priceUsd: 110_000, year: 2025, source: "namebio" },
  { domain: "precise.ai", priceUsd: 110_000, year: 2023, source: "namebio" },
  { domain: "tech.ai", priceUsd: 110_000, year: 2025, source: "namebio" },
  { domain: "certify.ai", priceUsd: 110_000, year: 2026, source: "namebio" },
  { domain: "surface.ai", priceUsd: 110_000, year: 2026, source: "namebio" },
  { domain: "crew.ai", priceUsd: 105_000, year: 2024, source: "namebio" },
  { domain: "confidential.ai", priceUsd: 105_000, year: 2026, source: "namebio" },
  { domain: "choice.ai", priceUsd: 100_000, year: 2026, source: "namebio" },
  { domain: "dealer.ai", priceUsd: 100_000, year: 2026, source: "namebio" },
  { domain: "synthetic.ai", priceUsd: 100_000, year: 2026, source: "namebio" },
  { domain: "evo.ai", priceUsd: 100_000, year: 2026, source: "namebio" },
  { domain: "mainstreet.ai", priceUsd: 100_000, year: 2026, source: "namebio" },
  { domain: "climb.ai", priceUsd: 100_000, year: 2026, source: "namebio" },
  { domain: "enclave.ai", priceUsd: 100_000, year: 2026, source: "namebio" },
  { domain: "cloudx.ai", priceUsd: 100_000, year: 2025, source: "namebio" },
  { domain: "estate.ai", priceUsd: 100_000, year: 2025, source: "namebio" },
  { domain: "tether.ai", priceUsd: 100_000, year: 2025, source: "namebio" },
  { domain: "h1.ai", priceUsd: 100_000, year: 2025, source: "namebio" },
];

export interface FetchAiSalesOpts {
  /** Only return sales in [sinceYear, …]. */
  sinceYear?: number;
}

/**
 * Returns `.ai` sales. v1: the embedded public sample (offline, deterministic).
 * Production swaps this for a live NameBio/Doma pull behind the same signature.
 */
export async function fetchAiSales(opts: FetchAiSalesOpts = {}): Promise<AiSale[]> {
  const since = opts.sinceYear ?? 0;
  return REPORTED_AI_SALES.filter((s) => s.year >= since);
}
