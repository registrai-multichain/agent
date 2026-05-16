import { buildWarsawVerifiableAgent } from "../src/agents/warsaw-verifiable.js";
import { log } from "@registrai/agent-sdk";
import { config as loadEnv } from "dotenv";
import deployment from "../../contracts/deployments/arc-testnet.json" with { type: "json" };

loadEnv();

async function main() {
  const c = deployment.contracts as Record<string, string>;
  const verifiableFeed = (deployment as { feeds?: Array<{ id: string; symbol: string }> }).feeds
    ?.find((f) => f.symbol === "WARSAW_RESI_MEDIAN_VERIFIABLE");
  if (!verifiableFeed) throw new Error("verifiable feed not found in manifest");

  const agent = buildWarsawVerifiableAgent({
    feedId: verifiableFeed.id as `0x${string}`,
    registryAddress: c.Registry_v1_1 as `0x${string}`,
    attestationAddress: c.Attestation_v1_1 as `0x${string}`,
    methodologyCid: "ipfs://warsaw-resi-median-v1",
    ruleAddress: c.MedianRule as `0x${string}`,
    otodomUrl: process.env.WARSAW_OTODOM_URL ?? "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/mazowieckie/warszawa/warszawa/warszawa",
  });

  const result = await agent.attest({
    privateKey: process.env.PRIVATE_KEY! as `0x${string}`,
    rpcUrl: process.env.RPC!,
  });
  log.info("smoke: done", { tx: result.txHash, n: result.rawInputs?.length });
}

main().catch((e) => { console.error(e); process.exit(1); });
