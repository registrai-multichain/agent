/**
 * Demo-time Kraków oracle attestation.
 *
 * Usage:
 *   pnpm tsx scripts/demo-krakow.ts <feedId>
 *
 * Where <feedId> is the bytes32 returned from the /agents/create form
 * after registering a Kraków residential feed. The script:
 *
 *   1. Fetches Otodom Kraków listings (real HTTP)
 *   2. Computes trimmed median PLN/sqm
 *   3. Signs + submits Attestation v2 .attest(feedId, value, inputHash)
 *   4. Prints tx hash + ArcScan link
 *
 * Wall-clock typically 5-15 seconds. Same wallet must own the agent
 * registration (PRIVATE_KEY in env). Used at demo time to populate the
 * just-registered feed with a real attestation.
 *
 * For ongoing production attestation, also wire the agent into the
 * worker cron — this script is just the first-pulse trigger.
 */

import { buildKrakowAgent } from "../src/agents/krakow.js";
import { log } from "@registrai/agent-sdk";
import { config as loadEnv } from "dotenv";
import deployment from "../../contracts/deployments/arc-testnet.json" with { type: "json" };

// Load agent/.env first (RPC etc.), then fall back to contracts/.env which
// holds the deployer's PRIVATE_KEY (the wallet that registered the feed).
loadEnv();
loadEnv({ path: "../contracts/.env" });

const DEFAULT_KRAKOW_URL =
  "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/malopolskie/krakow";

async function main() {
  const feedId = process.argv[2];
  if (!feedId || !/^0x[0-9a-fA-F]{64}$/.test(feedId)) {
    console.error("usage: pnpm tsx scripts/demo-krakow.ts <feedId>");
    console.error("  feedId must be a bytes32 hex string (66 chars, 0x prefix)");
    process.exit(1);
  }

  const c = deployment.contracts as Record<string, string>;
  const registryV2 = c.Registry_v2;
  const attestationV2 = c.Attestation_v2;
  if (!registryV2 || !attestationV2) {
    throw new Error("Registry_v2 / Attestation_v2 missing from arc-testnet.json");
  }

  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in env");
  if (!rpcUrl) throw new Error("RPC not set in env");

  const otodomUrl = process.env.KRAKOW_OTODOM_URL ?? DEFAULT_KRAKOW_URL;

  console.log(`  → feedId:    ${feedId}`);
  console.log(`  → source:    ${otodomUrl}`);
  console.log(`  → wallet:    ${privateKey.slice(0, 10)}…`);
  console.log(``);

  // Fetch the actual methodology text the user committed via the form.
  // SDK's preflight() hashes this and compares to the onchain methodologyHash;
  // hardcoding would break if the user edited the textarea.
  console.log(`  → fetching methodology from worker...`);
  const methodologyUrl =
    `https://registrai-agents.guanyidu98.workers.dev/feed-methodology?feedId=${feedId}`;
  const methoRes = await fetch(methodologyUrl);
  const methoJson = (await methoRes.json()) as { methodology?: string | null };
  if (!methoJson.methodology) {
    throw new Error(
      `methodology not yet saved to worker for ${feedId} — complete the form's methodology signature first`,
    );
  }
  console.log(`  → methodology: ${methoJson.methodology.length} chars committed`);
  console.log(``);
  console.log(`  → fetching Otodom Kraków listings...`);

  const startedAt = Date.now();

  const agent = buildKrakowAgent({
    feedId: feedId as `0x${string}`,
    registryAddress: registryV2 as `0x${string}`,
    attestationAddress: attestationV2 as `0x${string}`,
    methodologyCid: methoJson.methodology,
    otodomUrl,
  });

  const result = await agent.attest({
    privateKey: privateKey as `0x${string}`,
    rpcUrl,
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(``);
  console.log(`  ✓ attested in ${elapsedSec}s`);
  console.log(`  ✓ tx:         ${result.txHash}`);
  console.log(`  ✓ ArcScan:    ${deployment.explorer}/tx/${result.txHash}`);
  console.log(`  ✓ value:      ${result.value} PLN/sqm`);
  console.log(``);
  console.log(`  Feed page:    https://registrai.cc/feed/${feedId}/`);
  console.log(`  (Note: feed page may 404 for ad-hoc feeds — they aren't in the`);
  console.log(`   static manifest. View attestation history via ArcScan.)`);

  log.info("demo-krakow: done", { tx: result.txHash, value: result.value });
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
