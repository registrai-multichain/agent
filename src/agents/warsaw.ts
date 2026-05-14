/**
 * Warsaw residential PLN/sqm agent.
 *
 * Composes the SDK primitives with Warsaw-specific data sources to produce
 * the daily index. Methodology v1 spec lives at
 * /methodology/warsaw-resi-v1.md (IPFS CID committed onchain).
 */
import type { Address, Hex } from "viem";
import {
  defineAgent,
  hashRecords,
  median,
  trimByPercentile,
} from "@registrai/agent-sdk";
import { fetchOtodom, type Listing } from "../sources/otodom.js";
import { fetchNbpAnchor, type NbpAnchor } from "../sources/nbp.js";

const OUTLIER_PCT = 0.05;
const MIN_LISTINGS = 20;
const CALIBRATION_BOUNDS: [number, number] = [0.5, 2.0];

export interface WarsawAgentEnv {
  feedId: Hex;
  registryAddress: Address;
  attestationAddress: Address;
  methodologyCid: string;
  otodomUrl: string;
  nbpReportUrl: string;
}

export function buildWarsawAgent(env: WarsawAgentEnv) {
  return defineAgent({
    name: "warsaw-resi",
    schedule: "0 14 * * *", // daily 14:00 UTC
    feedId: env.feedId,
    registryAddress: env.registryAddress,
    attestationAddress: env.attestationAddress,
    methodologyCid: env.methodologyCid,
    async run() {
      const [otodom, nbp] = await Promise.all([
        fetchOtodom(env.otodomUrl),
        fetchNbpAnchor(env.nbpReportUrl),
      ]);
      return computeWarsawIndex({ listings: otodom.listings, nbpAnchor: nbp });
    },
  });
}

export interface ComputeResult {
  value: number;
  inputHash: Hex;
  context: {
    rawMedian: number;
    calibrationFactor: number;
    retained: number;
    dropped: number;
    nbpPeriod: string;
  };
}

export function computeWarsawIndex(input: {
  listings: readonly Listing[];
  nbpAnchor: NbpAnchor;
}): ComputeResult {
  if (input.listings.length < MIN_LISTINGS) {
    throw new Error(
      `compute: too few listings (${input.listings.length}), refusing to attest`,
    );
  }

  const { retained, dropped } = trimByPercentile(
    input.listings,
    OUTLIER_PCT,
    (l) => l.pricePerSqm,
  );
  const rawMedian = median(retained.map((l) => l.pricePerSqm));
  if (rawMedian <= 0) throw new Error("compute: non-positive rawMedian");

  const calibrationFactor = input.nbpAnchor.warsawSecondaryAvgPricePerSqm / rawMedian;
  if (
    calibrationFactor < CALIBRATION_BOUNDS[0] ||
    calibrationFactor > CALIBRATION_BOUNDS[1]
  ) {
    throw new Error(
      `compute: calibration factor ${calibrationFactor.toFixed(3)} outside sanity bounds`,
    );
  }

  const value = Math.round(rawMedian * calibrationFactor);

  const inputHash = hashRecords(
    retained.map((l) => ({ id: l.id, value: l.pricePerSqm })),
    2,
    `nbp:${input.nbpAnchor.version}`,
  );

  return {
    value,
    inputHash,
    context: {
      rawMedian,
      calibrationFactor,
      retained: retained.length,
      dropped,
      nbpPeriod: input.nbpAnchor.reportPeriod,
    },
  };
}
