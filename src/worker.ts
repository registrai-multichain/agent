/**
 * Cloudflare Worker entry for the Registrai first-party agents.
 *
 * One Worker, multiple cron triggers, multiple agents — all signing from
 * one TEE-or-not wallet, each registered as an agent against its own feed
 * with its own bond. Adding a new feed = adding a cron entry to
 * wrangler.toml + a dispatch line below + an agent module.
 *
 * Secrets (set via `wrangler secret put`): PRIVATE_KEY, RPC_URL, NBP_REPORT_URL.
 * Public bindings (in wrangler.toml [vars]): contract addresses, feed ids,
 * methodology CIDs.
 */
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { buildWarsawAgent } from "./agents/warsaw.js";
import { buildPolishCpiAgent } from "./agents/polish-cpi.js";
import { buildEcbRateAgent } from "./agents/ecb-rate.js";
import { generateProposals, type ProposalSet } from "./agents/proposer.js";
import { attestationAbi, log } from "@registrai/agent-sdk";

export interface Env {
  // Secrets
  PRIVATE_KEY: string;
  RPC_URL: string;
  NBP_REPORT_URL: string;
  GUS_REPORT_URL: string;
  ECB_REPORT_URL: string;
  ANTHROPIC_API_KEY?: string;

  // Public config — Warsaw
  REGISTRY_ADDRESS: string;
  ATTESTATION_ADDRESS: string;
  WARSAW_FEED_ID: string;
  WARSAW_AGENT_ADDRESS: string;
  WARSAW_METHODOLOGY_CID: string;
  WARSAW_OTODOM_URL?: string;

  // Public config — Polish CPI
  POLISH_CPI_FEED_ID?: string;
  POLISH_CPI_METHODOLOGY_CID?: string;

  // Public config — ECB rate
  ECB_RATE_FEED_ID?: string;
  ECB_RATE_METHODOLOGY_CID?: string;

  // KV store for LLM-proposed markets (read by frontend over fetch).
  PROPOSALS: KVNamespace;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const DEFAULT_OTODOM_URL =
  "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/mazowieckie/warszawa/warszawa/warszawa";

export default {
  /**
   * Cloudflare invokes `scheduled` on each cron trigger. We dispatch by the
   * cron expression that fired (Cloudflare passes it as event.cron).
   */
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    log.info("worker: scheduled", { cron: event.cron });

    if (event.cron === "0 14 * * *") {
      // Daily attestation tick — fan out across every first-party agent.
      // Each agent is fully isolated; one failing doesn't stop the others.
      await Promise.allSettled([
        runWarsaw(env),
        runPolishCpi(env),
        runEcbRate(env),
      ]);
    } else if (event.cron === "0 */6 * * *") {
      await runProposer(env);
    } else {
      log.warn("worker: unknown cron, ignoring", { cron: event.cron });
    }
  },

  /**
   * The Worker also serves the latest proposals over HTTP so the static
   * frontend can fetch them without an RPC roundtrip.
   * GET /proposals?feedId=0x... → ProposalSet JSON
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/proposals") {
      const feedId = url.searchParams.get("feedId") ?? env.WARSAW_FEED_ID;
      const raw = await env.PROPOSALS.get(`proposals:${feedId}`);
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };
      if (!raw) {
        return new Response(JSON.stringify({ proposals: [] }), { status: 200, headers: cors });
      }
      return new Response(raw, { status: 200, headers: cors });
    }
    return new Response("Registrai agents worker. /proposals?feedId=…", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
} satisfies ExportedHandler<Env>;

async function runProposer(env: Env): Promise<void> {
  // Read the latest attestation for the Warsaw feed directly from chain.
  const rpcUrl = env.RPC_URL;
  const chain = defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const feedId = env.WARSAW_FEED_ID as Hex;
  const agent = env.WARSAW_AGENT_ADDRESS as `0x${string}`;

  const [value, , finalized] = (await client.readContract({
    address: env.ATTESTATION_ADDRESS as `0x${string}`,
    abi: attestationAbi,
    functionName: "latestValue" as never,
    args: [feedId, agent] as never,
  })) as [bigint, bigint, boolean];

  log.info("proposer: latest", { value: value.toString(), finalized });

  const set: ProposalSet = await generateProposals(
    {
      feedSymbol: "WARSAW_RESI_PLN_SQM",
      feedDescription:
        "Warsaw average residential price per square meter, secondary sale market",
      feedId,
      unit: "PLN/sqm",
      currentValue: Number(value),
      recentValues: [Number(value)],
      existingThresholds: [17000, 17500, 18000],
    },
    { anthropicApiKey: env.ANTHROPIC_API_KEY },
  );

  await env.PROPOSALS.put(`proposals:${feedId}`, JSON.stringify(set), {
    // Keep around for a week even if the worker stops updating.
    expirationTtl: 7 * 86400,
  });
  log.info("proposer: stored proposals", {
    source: set.source,
    count: set.proposals.length,
  });
}

async function runWarsaw(env: Env): Promise<void> {
  const agent = buildWarsawAgent({
    feedId: env.WARSAW_FEED_ID as `0x${string}`,
    registryAddress: env.REGISTRY_ADDRESS as `0x${string}`,
    attestationAddress: env.ATTESTATION_ADDRESS as `0x${string}`,
    methodologyCid: env.WARSAW_METHODOLOGY_CID,
    otodomUrl: env.WARSAW_OTODOM_URL ?? DEFAULT_OTODOM_URL,
    nbpReportUrl: env.NBP_REPORT_URL,
  });

  try {
    const result = await agent.attest({
      privateKey: env.PRIVATE_KEY as `0x${string}`,
      rpcUrl: env.RPC_URL,
    });
    log.info("worker: warsaw attested", {
      txHash: result.txHash,
      value: result.value.toString(),
    });
  } catch (e) {
    // Don't rethrow — failures here should not crash the Worker (Cloudflare
    // would retry, possibly triggering double attestations). Log and exit.
    log.error("worker: warsaw failed", { error: (e as Error).message });
  }
}

async function runPolishCpi(env: Env): Promise<void> {
  if (!env.POLISH_CPI_FEED_ID) {
    log.info("worker: polish-cpi not configured, skipping");
    return;
  }
  const agent = buildPolishCpiAgent({
    feedId: env.POLISH_CPI_FEED_ID as `0x${string}`,
    registryAddress: env.REGISTRY_ADDRESS as `0x${string}`,
    attestationAddress: env.ATTESTATION_ADDRESS as `0x${string}`,
    methodologyCid: env.POLISH_CPI_METHODOLOGY_CID ?? "ipfs://polish-cpi-v1-placeholder",
    gusReportUrl: env.GUS_REPORT_URL,
  });
  try {
    const result = await agent.attest({
      privateKey: env.PRIVATE_KEY as `0x${string}`,
      rpcUrl: env.RPC_URL,
    });
    log.info("worker: polish-cpi attested", {
      txHash: result.txHash,
      value: result.value.toString(),
    });
  } catch (e) {
    log.error("worker: polish-cpi failed", { error: (e as Error).message });
  }
}

async function runEcbRate(env: Env): Promise<void> {
  if (!env.ECB_RATE_FEED_ID) {
    log.info("worker: ecb-rate not configured, skipping");
    return;
  }
  const agent = buildEcbRateAgent({
    feedId: env.ECB_RATE_FEED_ID as `0x${string}`,
    registryAddress: env.REGISTRY_ADDRESS as `0x${string}`,
    attestationAddress: env.ATTESTATION_ADDRESS as `0x${string}`,
    methodologyCid: env.ECB_RATE_METHODOLOGY_CID ?? "ipfs://ecb-rate-v1-placeholder",
    ecbReportUrl: env.ECB_REPORT_URL,
  });
  try {
    const result = await agent.attest({
      privateKey: env.PRIVATE_KEY as `0x${string}`,
      rpcUrl: env.RPC_URL,
    });
    log.info("worker: ecb-rate attested", {
      txHash: result.txHash,
      value: result.value.toString(),
    });
  } catch (e) {
    log.error("worker: ecb-rate failed", { error: (e as Error).message });
  }
}

// Minimal Cloudflare Worker type declarations so this compiles without the
// `@cloudflare/workers-types` dependency (which we'd add when wiring wrangler).
declare global {
  interface ScheduledEvent {
    cron: string;
    scheduledTime: number;
  }
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
  interface ExportedHandler<TEnv = unknown> {
    scheduled?: (event: ScheduledEvent, env: TEnv, ctx: ExecutionContext) => Promise<void> | void;
    fetch?: (request: Request, env: TEnv, ctx: ExecutionContext) => Promise<Response> | Response;
  }
}
