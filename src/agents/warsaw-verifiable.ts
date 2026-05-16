/**
 * Warsaw residential · verifiable variant.
 *
 * Sister agent to warsaw.ts. Same data source (Otodom listings) but the
 * aggregation runs onchain via MedianRule: this agent submits the raw
 * per-listing PLN/sqm values, and the rule contract computes the median.
 *
 * The attested value is therefore re-derivable from chain alone — pull
 * inputHash from the Attested event, recover rawInputs from the attest
 * tx calldata, call MedianRule.submit(rawInputs), check the value
 * matches. No off-chain math to trust.
 *
 * Caveat: MedianRule.MAX_INPUT = 128. We trim by percentile (matching the
 * v1 outlier behavior) and take up to the first 128 retained listings.
 * Calibration to the NBP anchor is intentionally dropped — the v1 method
 * anchored to a government figure, which moved the trust off-chain. v1.1
 * trusts the market median itself.
 */
import type { Address, Hex } from "viem";
import { defineAgent, trimByPercentile } from "@registrai/agent-sdk";
import { fetchOtodom, type Listing } from "../sources/otodom.js";

const OUTLIER_PCT = 0.05;
const MIN_LISTINGS = 20;
const MAX_RAW_INPUTS = 128;

export interface WarsawVerifiableEnv {
  feedId: Hex;
  registryAddress: Address;
  attestationAddress: Address;
  methodologyCid: string;
  ruleAddress: Address;
  otodomUrl: string;
}

export function buildWarsawVerifiableAgent(env: WarsawVerifiableEnv) {
  return defineAgent({
    name: "warsaw-resi-verifiable",
    schedule: "0 14 * * *", // daily 14:00 UTC, same cron as v1
    feedId: env.feedId,
    registryAddress: env.registryAddress,
    attestationAddress: env.attestationAddress,
    methodologyCid: env.methodologyCid,
    rule: env.ruleAddress,
    async run() {
      const otodom = await fetchOtodom(env.otodomUrl);
      return prepareRawInputs(otodom.listings);
    },
  });
}

export interface RawInputsResult {
  rawInputs: bigint[];
  context: {
    fetched: number;
    retained: number;
    dropped: number;
    capped: boolean;
  };
}

export function prepareRawInputs(listings: readonly Listing[]): RawInputsResult {
  if (listings.length < MIN_LISTINGS) {
    throw new Error(
      `warsaw-verifiable: too few listings (${listings.length}), refusing to attest`,
    );
  }
  const { retained, dropped } = trimByPercentile(
    listings,
    OUTLIER_PCT,
    (l) => l.pricePerSqm,
  );
  const capped = retained.length > MAX_RAW_INPUTS;
  const slice = capped ? retained.slice(0, MAX_RAW_INPUTS) : retained;
  const rawInputs = slice.map((l) => BigInt(Math.round(l.pricePerSqm)));
  return {
    rawInputs,
    context: {
      fetched: listings.length,
      retained: retained.length,
      dropped,
      capped,
    },
  };
}
