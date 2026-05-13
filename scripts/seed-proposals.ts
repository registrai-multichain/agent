/**
 * One-shot script to seed the PROPOSALS KV namespace with an initial set
 * of agent-suggested markets. The cron-driven proposer will overwrite on
 * the next 6-hour tick — this just primes the demo with content out of
 * the gate.
 *
 *   tsx scripts/seed-proposals.ts | wrangler kv key put \
 *     --namespace-id=<id> "proposals:<feedId>" --path=-
 */
import { generateProposals } from "../src/agents/proposer.js";
import deployment from "../../contracts/deployments/arc-testnet.json" with { type: "json" };

async function main() {
  const set = await generateProposals(
    {
      feedSymbol: "WARSAW_RESI_PLN_SQM",
      feedDescription:
        "Warsaw average residential price per square meter, secondary sale market",
      feedId: deployment.warsawFeed.feedId as `0x${string}`,
      unit: "PLN/sqm",
      currentValue: deployment.warsawFeed.firstAttestation.value,
      recentValues: [deployment.warsawFeed.firstAttestation.value],
      existingThresholds: (deployment.markets as Array<{ threshold: number }>).map(
        (m) => m.threshold,
      ),
    },
    { anthropicApiKey: process.env.ANTHROPIC_API_KEY },
  );
  process.stdout.write(JSON.stringify(set));
}

main();
