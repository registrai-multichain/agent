/**
 * Kraków residential PLN/sqm agent.
 *
 * Lighter than the Warsaw agent: no NBP calibration (NBP's secondary-market
 * report is Warsaw-specific). Direct median over trimmed Otodom listings.
 *
 * Methodology committed onchain as a bytecode-hash of the user's
 * methodology textarea (see /agents/create).
 */
import type { Address, Hex } from "viem";
import {
  defineAgent,
  hashRecords,
  median,
  trimByPercentile,
} from "@registrai/agent-sdk";
import { fetchOtodom, type Listing } from "../sources/otodom.js";

const OUTLIER_PCT = 0.05;
const MIN_LISTINGS = 10; // looser than Warsaw — Kraków supply is smaller
const SANITY_LO = 5_000;  // PLN/sqm — reject if median below
const SANITY_HI = 30_000; // PLN/sqm — reject if median above

export interface KrakowAgentEnv {
  feedId: Hex;
  registryAddress: Address;
  attestationAddress: Address;
  methodologyCid: string;
  otodomUrl: string;
}

export function buildKrakowAgent(env: KrakowAgentEnv) {
  return defineAgent({
    name: "krakow-resi",
    schedule: "30 14 * * *", // daily 14:30 UTC (30 min offset from Warsaw)
    feedId: env.feedId,
    registryAddress: env.registryAddress,
    attestationAddress: env.attestationAddress,
    methodologyCid: env.methodologyCid,
    async run() {
      // 3 pages keeps the fetch under ~7s while still yielding 70+ listings,
      // well above MIN_LISTINGS. Faster for demo + production both.
      const otodom = await fetchOtodom(env.otodomUrl, 3);
      return computeKrakowIndex({ listings: otodom.listings });
    },
  });
}

export interface ComputeResult {
  value: number;
  inputHash: Hex;
  context: {
    rawMedian: number;
    retained: number;
    dropped: number;
  };
}

export function computeKrakowIndex(input: {
  listings: readonly Listing[];
}): ComputeResult {
  if (input.listings.length < MIN_LISTINGS) {
    throw new Error(
      `compute: too few Kraków listings (${input.listings.length}), refusing to attest`,
    );
  }

  const { retained, dropped } = trimByPercentile(
    input.listings,
    OUTLIER_PCT,
    (l) => l.pricePerSqm,
  );
  const rawMedian = median(retained.map((l) => l.pricePerSqm));
  if (rawMedian <= 0) throw new Error("compute: non-positive median");
  if (rawMedian < SANITY_LO || rawMedian > SANITY_HI) {
    throw new Error(
      `compute: median ${rawMedian.toFixed(0)} outside sanity bounds [${SANITY_LO}, ${SANITY_HI}]`,
    );
  }

  const value = Math.round(rawMedian);

  const inputHash = hashRecords(
    retained.map((l) => ({ id: l.id, value: l.pricePerSqm })),
    2,
    "krakow-v1",
  );

  return {
    value,
    inputHash,
    context: {
      rawMedian,
      retained: retained.length,
      dropped,
    },
  };
}
