/**
 * ECB main refinancing operations rate agent. Attests the value in basis
 * points — e.g., 3.00% = 300 bps. Methodology v1 spec lives at
 * /methodology/ecb-rate-v1.md.
 */
import type { Address, Hex } from "viem";
import { defineAgent, hashRecords } from "../sdk/index.js";
import { fetchEcbRate, type EcbRateReading } from "../sources/ecb.js";

export interface EcbRateAgentEnv {
  feedId: Hex;
  registryAddress: Address;
  attestationAddress: Address;
  methodologyCid: string;
  ecbReportUrl: string;
}

export function buildEcbRateAgent(env: EcbRateAgentEnv) {
  return defineAgent({
    name: "ecb-rate",
    schedule: "0 14 * * *", // daily 14:00 UTC — value changes on ECB decision days only
    feedId: env.feedId,
    registryAddress: env.registryAddress,
    attestationAddress: env.attestationAddress,
    methodologyCid: env.methodologyCid,
    async run() {
      const rate = await fetchEcbRate(env.ecbReportUrl);
      return computeEcbRate(rate);
    },
  });
}

export interface ComputeResult {
  value: number;
  inputHash: Hex;
  context: {
    decisionDate: string;
    mainRefiPercent: number;
  };
}

export function computeEcbRate(reading: EcbRateReading): ComputeResult {
  // ECB main refi has been in [-0.50, 5.00] historically. Tight sanity bounds.
  if (reading.mainRefiPercent < -1 || reading.mainRefiPercent > 10) {
    throw new Error(
      `ecb-rate: rate ${reading.mainRefiPercent} outside sanity bounds [-1, 10]`,
    );
  }

  // Onchain integer = bps. 3.00% → 300.
  const value = Math.round(reading.mainRefiPercent * 100);

  // Input hash commits to the decision-date + value + version.
  const inputHash = hashRecords(
    [{ id: reading.decisionDate, value: reading.mainRefiPercent }],
    2,
    `ecb:${reading.version}`,
  );

  return {
    value,
    inputHash,
    context: {
      decisionDate: reading.decisionDate,
      mainRefiPercent: reading.mainRefiPercent,
    },
  };
}
