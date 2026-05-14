/**
 * Polish CPI (Y/Y) agent. Attests the value in basis points so the on-chain
 * integer is meaningful — e.g., 4.20% = 420 bps. Methodology v1 spec lives
 * at /methodology/polish-cpi-v1.md.
 */
import type { Address, Hex } from "viem";
import { defineAgent, hashRecords } from "../sdk/index.js";
import { fetchPolishCpi, type GusCpiReading } from "../sources/gus.js";

export interface PolishCpiAgentEnv {
  feedId: Hex;
  registryAddress: Address;
  attestationAddress: Address;
  methodologyCid: string;
  gusReportUrl: string;
}

export function buildPolishCpiAgent(env: PolishCpiAgentEnv) {
  return defineAgent({
    name: "polish-cpi",
    schedule: "0 14 * * *", // daily 14:00 UTC — value only changes on monthly print
    feedId: env.feedId,
    registryAddress: env.registryAddress,
    attestationAddress: env.attestationAddress,
    methodologyCid: env.methodologyCid,
    async run() {
      const cpi = await fetchPolishCpi(env.gusReportUrl);
      return computePolishCpi(cpi);
    },
  });
}

export interface ComputeResult {
  value: number;
  inputHash: Hex;
  context: {
    period: string;
    yoyPercent: number;
  };
}

export function computePolishCpi(reading: GusCpiReading): ComputeResult {
  // Sanity bounds — Polish CPI in the last 30 years has never been outside
  // [-2%, +20%]. A value outside this range suggests the source is broken.
  if (reading.yoyPercent < -2 || reading.yoyPercent > 20) {
    throw new Error(
      `polish-cpi: yoy ${reading.yoyPercent} outside sanity bounds [-2, 20]`,
    );
  }

  // Onchain integer = bps (2 decimal places). 4.20% → 420.
  const value = Math.round(reading.yoyPercent * 100);

  // Input hash commits to the period + value + version. Anyone re-reading the
  // GUS mirror at the same period can verify by recomputing this hash.
  const inputHash = hashRecords(
    [{ id: reading.period, value: reading.yoyPercent }],
    2,
    `gus:${reading.version}`,
  );

  return {
    value,
    inputHash,
    context: {
      period: reading.period,
      yoyPercent: reading.yoyPercent,
    },
  };
}
