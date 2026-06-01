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
import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  recoverMessageAddress,
  toHex,
  type Hex,
} from "viem";
import { buildWarsawAgent } from "./agents/warsaw.js";
import { buildWarsawVerifiableAgent } from "./agents/warsaw-verifiable.js";
import { buildPolishCpiAgent } from "./agents/polish-cpi.js";
import { buildEcbRateAgent } from "./agents/ecb-rate.js";
import { generateProposals, type ProposalSet } from "./agents/proposer.js";
import { runMarketMaker } from "./bots/mm.js";
import { handleQuestRequest } from "./social-oracle.js";
import { runCirqueKeeper } from "./cirque-keeper.js";
import { runBetKeeper } from "./bet-keeper.js";
import { attestationAbi, log } from "@registrai/agent-sdk";

export interface Env {
  // Secrets
  PRIVATE_KEY: string;
  RPC_URL: string;
  NBP_REPORT_URL: string;
  GUS_REPORT_URL: string;
  ECB_REPORT_URL: string;
  ANTHROPIC_API_KEY?: string;
  TRADER_PRIVATE_KEY?: string;

  // Public config — Warsaw
  REGISTRY_ADDRESS: string;
  ATTESTATION_ADDRESS: string;
  WARSAW_FEED_ID: string;
  WARSAW_AGENT_ADDRESS: string;
  WARSAW_METHODOLOGY_CID: string;
  WARSAW_OTODOM_URL?: string;

  // Public config — Warsaw verifiable (v1.1 Registry + Attestation, rule-bound)
  WARSAW_VERIFIABLE_FEED_ID?: string;
  WARSAW_VERIFIABLE_METHODOLOGY_CID?: string;
  REGISTRY_V1_1?: string;
  ATTESTATION_V1_1?: string;
  MEDIAN_RULE?: string;

  // v2 protocol stack (where the social oracle and new agents live).
  REGISTRY_V2?: string;

  // v0.5 CirqueLending — bonded BTC/USD oracle agent + cirBTC integrity
  // monitor. Optional; cron handler skips the keeper if any of these is
  // missing.
  CIRQUE_LENDING_ADDR?: string;
  KEEPER_PRIVATE_KEY?: string;
  ATTESTATION_V2?: string;
  BTC_FEED_ID?: string;
  CIRBTC_ADDR?: string;
  CIRBTC_EXPECTED_OWNER?: string;

  // CirqueBetLending — force-close keeper (write-off + profitable liquidation).
  // Optional; cron skips it until the contract is deployed and configured.
  BET_LENDING_ADDR?: string;
  BET_KEEPER_PRIVATE_KEY?: string;
  MARKETS_V3_ADDR?: string;
  USDC_ADDR?: string;
  BET_LENDING_DEPLOY_BLOCK?: string;

  // Public config — Polish CPI
  POLISH_CPI_FEED_ID?: string;
  POLISH_CPI_METHODOLOGY_CID?: string;

  // Public config — ECB rate
  ECB_RATE_FEED_ID?: string;
  ECB_RATE_METHODOLOGY_CID?: string;

  // KV store for LLM-proposed markets (read by frontend over fetch).
  PROPOSALS: KVNamespace;
  /** Creator-supplied market descriptions, keyed by marketId. Signature-gated. */
  MARKET_DESCRIPTIONS: KVNamespace;
  /** Social-quest claims and twitter-handle bindings. */
  SOCIAL_CLAIMS: KVNamespace;

  // For description-write signature verification: both Markets v1.0 + v1.1
  // are accepted (the worker tries each in turn).
  MARKETS_ADDR?: string;
  MARKETS_V1_1_ADDR?: string;

  // Social signal oracle — bonded agent that mints quest credits.
  SOCIAL_PRIVATE_KEY?: string;
  /** v2 RegistraiPoints contract used by the social oracle for awardFlat. */
  REGISTRAI_POINTS_ADDR?: string;
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
        runWarsawVerifiable(env),
        runPolishCpi(env),
        runEcbRate(env),
      ]);
    } else if (event.cron === "0 */6 * * *") {
      await runProposer(env);
    } else if (event.cron === "*/15 * * * *") {
      await runMarketMaker({ TRADER_PRIVATE_KEY: env.TRADER_PRIVATE_KEY, RPC_URL: env.RPC_URL });
    } else if (event.cron === "*/30 * * * *") {
      // v0.5 CirqueLending: bonded BTC/USD oracle agent + cirBTC integrity
      // monitor. Attests every 30 min if all 4 cirBTC integrity probes
      // pass. Skipped silently if not fully configured.
      if (
        env.CIRQUE_LENDING_ADDR &&
        env.KEEPER_PRIVATE_KEY &&
        env.ATTESTATION_V2 &&
        env.BTC_FEED_ID &&
        env.CIRBTC_ADDR &&
        env.CIRBTC_EXPECTED_OWNER
      ) {
        await runCirqueKeeper({
          RPC_URL: env.RPC_URL,
          KEEPER_PRIVATE_KEY: env.KEEPER_PRIVATE_KEY,
          CIRQUE_LENDING_ADDR: env.CIRQUE_LENDING_ADDR,
          ATTESTATION_V2: env.ATTESTATION_V2,
          BTC_FEED_ID: env.BTC_FEED_ID,
          CIRBTC_ADDR: env.CIRBTC_ADDR,
          CIRBTC_EXPECTED_OWNER: env.CIRBTC_EXPECTED_OWNER,
        });
      }

      // CirqueBetLending force-close keeper: write off resolved-loser loans
      // (free) and force-close profitable positions near expiry. Skipped until
      // the contract is deployed and these are configured.
      if (
        env.BET_LENDING_ADDR &&
        env.BET_KEEPER_PRIVATE_KEY &&
        env.MARKETS_V3_ADDR &&
        env.USDC_ADDR
      ) {
        await runBetKeeper({
          RPC_URL: env.RPC_URL,
          BET_KEEPER_PRIVATE_KEY: env.BET_KEEPER_PRIVATE_KEY,
          BET_LENDING_ADDR: env.BET_LENDING_ADDR,
          MARKETS_V3_ADDR: env.MARKETS_V3_ADDR,
          USDC_ADDR: env.USDC_ADDR,
          BET_LENDING_DEPLOY_BLOCK: env.BET_LENDING_DEPLOY_BLOCK,
        });
      }
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
    // Restrict to our own origins. Anything else still works (open CORS for
    // SDK consumers / cli), but quest endpoints are gated below.
    const origin = request.headers.get("Origin") ?? "";
    const allowedOrigin = isAllowedOrigin(origin) ? origin : "https://registrai.cc";
    const cors = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Content-Type": "application/json",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/proposals") {
      const feedId = url.searchParams.get("feedId") ?? env.WARSAW_FEED_ID;
      const raw = await env.PROPOSALS.get(`proposals:${feedId}`);
      if (!raw) {
        return new Response(JSON.stringify({ proposals: [] }), { status: 200, headers: cors });
      }
      return new Response(raw, { status: 200, headers: cors });
    }

    if (url.pathname === "/market-description") {
      if (request.method === "GET") {
        const marketId = url.searchParams.get("marketId");
        if (!marketId) {
          return new Response(JSON.stringify({ error: "marketId required" }), {
            status: 400,
            headers: cors,
          });
        }
        const raw = await env.MARKET_DESCRIPTIONS.get(`desc:${marketId.toLowerCase()}`);
        return new Response(raw ?? JSON.stringify({ description: null }), {
          status: 200,
          headers: cors,
        });
      }
      if (request.method === "POST") {
        return await handleDescriptionWrite(request, env, cors);
      }
      return new Response("method not allowed", { status: 405, headers: cors });
    }

    // Feed methodology — creator-signed prose explaining the data source +
    // aggregation rules. Hashed into the feed's onchain identity; the text
    // itself is stored here so anyone can read it.
    if (url.pathname === "/feed-methodology") {
      if (request.method === "GET") {
        const feedId = url.searchParams.get("feedId");
        if (!feedId) {
          return new Response(JSON.stringify({ error: "feedId required" }), {
            status: 400, headers: cors,
          });
        }
        const raw = await env.MARKET_DESCRIPTIONS.get(
          `methodology:${feedId.toLowerCase()}`,
        );
        return new Response(raw ?? JSON.stringify({ methodology: null }), {
          status: 200, headers: cors,
        });
      }
      if (request.method === "POST") {
        return await handleMethodologyWrite(request, env, cors);
      }
      return new Response("method not allowed", { status: 405, headers: cors });
    }

    // Social quest endpoints. The social signal oracle is its own bonded
    // agent on Arc; these endpoints verify off-chain proofs and mint credits.
    if (url.pathname.startsWith("/quest/")) {
      const res = await handleQuestRequest(request, env, cors);
      if (res) return res;
    }

    return new Response(
      "Registrai agents worker. /proposals · /market-description · /feed-methodology · /quest/twitter/{start,verify} · /quest/twitter/share-agent/{start,verify} · /quest/status",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * Allow-list for cross-origin requests. Anything else gets a default response
 * with `Access-Control-Allow-Origin: https://registrai.cc` — which means the
 * browser will block the request unless the caller is on registrai.cc.
 * Non-browser clients (cast / curl) work regardless.
 */
function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  // Production + preview deploys on Cloudflare Pages.
  if (origin === "https://registrai.cc") return true;
  if (origin === "https://www.registrai.cc") return true;
  if (/^https:\/\/[a-z0-9-]+\.registrai-web\.pages\.dev$/.test(origin)) return true;
  // Local dev.
  if (/^http:\/\/localhost:\d+$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  return false;
}

/**
 * Signature-gated write of a market description. Body shape:
 *   { marketId: "0x…", description: "…", signature: "0x…" }
 * Where signature signs the plaintext `registrai-market-description:${marketId}:${description}`.
 * The recovered address must match the market's creator field on chain.
 * Tries Markets v1.0 first, falls back to Markets v1.1.
 */
async function handleDescriptionWrite(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  type Body = { marketId?: string; description?: string; signature?: string };
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: cors });
  }
  const { marketId, description, signature } = body;
  if (!marketId || !description || !signature) {
    return new Response(
      JSON.stringify({ error: "marketId, description, signature required" }),
      { status: 400, headers: cors },
    );
  }
  if (description.length > 2000) {
    return new Response(JSON.stringify({ error: "description too long (max 2000)" }), {
      status: 400, headers: cors,
    });
  }

  const message = `registrai-market-description:${marketId.toLowerCase()}:${description}`;
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message, signature: signature as Hex });
  } catch {
    return new Response(JSON.stringify({ error: "bad signature" }), { status: 400, headers: cors });
  }

  // Look up the market's creator. Try Markets v1.0 then v1.1.
  const candidates = [env.MARKETS_ADDR, env.MARKETS_V1_1_ADDR].filter(
    (a): a is string => !!a,
  );
  const client = createPublicClient({
    chain: defineChain({
      id: 5042002, name: "Arc",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [env.RPC_URL] } },
    }),
    transport: http(env.RPC_URL),
  });
  const getMarketAbi = [{
    type: "function", name: "getMarket", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "feedId", type: "bytes32" }, { name: "agent", type: "address" },
      { name: "threshold", type: "int256" }, { name: "comparator", type: "uint8" },
      { name: "expiry", type: "uint256" }, { name: "creator", type: "address" },
      { name: "yesReserve", type: "uint256" }, { name: "noReserve", type: "uint256" },
      { name: "phase", type: "uint8" }, { name: "yesWon", type: "bool" },
      { name: "createdAt", type: "uint256" },
    ] }],
  }] as const;

  let creator: string | undefined;
  for (const addr of candidates) {
    try {
      const m = (await client.readContract({
        address: addr as Hex, abi: getMarketAbi, functionName: "getMarket",
        args: [marketId as Hex],
      })) as { creator: string; createdAt: bigint };
      if (m.createdAt > 0n) {
        creator = m.creator;
        break;
      }
    } catch { /* try next */ }
  }
  if (!creator) {
    return new Response(JSON.stringify({ error: "market not found" }), { status: 404, headers: cors });
  }
  if (signer.toLowerCase() !== creator.toLowerCase()) {
    return new Response(JSON.stringify({ error: "signer is not market creator" }), {
      status: 403, headers: cors,
    });
  }

  await env.MARKET_DESCRIPTIONS.put(
    `desc:${marketId.toLowerCase()}`,
    JSON.stringify({ description, creator, updatedAt: Math.floor(Date.now() / 1000) }),
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
}

/**
 * Signature-gated write of a feed methodology. Body shape:
 *   { feedId: "0x…", methodology: "…", signature: "0x…" }
 * Where signature signs `registrai-feed-methodology:${feedId}:${methodology}`.
 * The recovered address must match the feed's creator on chain (tries v2,
 * then v1.1, then v1.0 Registry).
 *
 * We ALSO verify keccak256(methodology) === onchain methodologyHash — so the
 * stored text can never drift from what was hashed at registration time.
 */
async function handleMethodologyWrite(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  type Body = { feedId?: string; methodology?: string; signature?: string };
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400, headers: cors,
    });
  }
  const { feedId, methodology, signature } = body;
  if (!feedId || !methodology || !signature) {
    return new Response(
      JSON.stringify({ error: "feedId, methodology, signature required" }),
      { status: 400, headers: cors },
    );
  }
  if (methodology.length > 8000) {
    return new Response(
      JSON.stringify({ error: "methodology too long (max 8000)" }),
      { status: 400, headers: cors },
    );
  }

  const message = `registrai-feed-methodology:${feedId.toLowerCase()}:${methodology}`;
  let signer: string;
  try {
    signer = await recoverMessageAddress({
      message,
      signature: signature as Hex,
    });
  } catch {
    return new Response(JSON.stringify({ error: "bad signature" }), {
      status: 400, headers: cors,
    });
  }

  // Look up the feed's creator + methodologyHash. Try v2 → v1.1 → v1.0.
  const registries = [
    env.REGISTRY_V2,
    env.REGISTRY_V1_1,
    env.REGISTRY_ADDRESS,
  ].filter((a): a is string => !!a);
  const client = createPublicClient({
    chain: defineChain({
      id: 5042002,
      name: "Arc",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [env.RPC_URL] } },
    }),
    transport: http(env.RPC_URL),
  });
  const getFeedAbi = [
    {
      type: "function",
      name: "getFeed",
      stateMutability: "view",
      inputs: [{ name: "feedId", type: "bytes32" }],
      outputs: [
        {
          type: "tuple",
          components: [
            { name: "creator", type: "address" },
            { name: "description", type: "string" },
            { name: "methodologyHash", type: "bytes32" },
            { name: "minBond", type: "uint256" },
            { name: "disputeWindow", type: "uint256" },
            { name: "resolver", type: "address" },
            { name: "createdAt", type: "uint256" },
            { name: "exists", type: "bool" },
          ],
        },
      ],
    },
  ] as const;

  let creator: string | undefined;
  let onchainHash: string | undefined;
  for (const addr of registries) {
    try {
      const f = (await client.readContract({
        address: addr as Hex,
        abi: getFeedAbi,
        functionName: "getFeed",
        args: [feedId as Hex],
      })) as { creator: string; methodologyHash: string; exists: boolean };
      if (f.exists) {
        creator = f.creator;
        onchainHash = f.methodologyHash;
        break;
      }
    } catch {
      /* try next registry */
    }
  }
  if (!creator || !onchainHash) {
    return new Response(JSON.stringify({ error: "feed not found" }), {
      status: 404, headers: cors,
    });
  }
  if (signer.toLowerCase() !== creator.toLowerCase()) {
    return new Response(
      JSON.stringify({ error: "signer is not feed creator" }),
      { status: 403, headers: cors },
    );
  }

  // Make sure the submitted text actually hashes to the value stored on
  // chain. Otherwise KV could drift from chain truth.
  const expectedHash = keccak256(toHex(methodology));
  if (expectedHash.toLowerCase() !== onchainHash.toLowerCase()) {
    return new Response(
      JSON.stringify({
        error: "methodology text does not match onchain hash",
        expected: onchainHash,
        got: expectedHash,
      }),
      { status: 400, headers: cors },
    );
  }

  await env.MARKET_DESCRIPTIONS.put(
    `methodology:${feedId.toLowerCase()}`,
    JSON.stringify({
      methodology,
      creator,
      updatedAt: Math.floor(Date.now() / 1000),
    }),
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
}

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
      value: result.value?.toString(),
    });
  } catch (e) {
    // Don't rethrow — failures here should not crash the Worker (Cloudflare
    // would retry, possibly triggering double attestations). Log and exit.
    log.error("worker: warsaw failed", { error: (e as Error).message });
  }
}

async function runWarsawVerifiable(env: Env): Promise<void> {
  if (!env.WARSAW_VERIFIABLE_FEED_ID || !env.REGISTRY_V1_1 || !env.ATTESTATION_V1_1 || !env.MEDIAN_RULE) {
    log.info("worker: warsaw-verifiable not configured, skipping");
    return;
  }
  const agent = buildWarsawVerifiableAgent({
    feedId: env.WARSAW_VERIFIABLE_FEED_ID as `0x${string}`,
    registryAddress: env.REGISTRY_V1_1 as `0x${string}`,
    attestationAddress: env.ATTESTATION_V1_1 as `0x${string}`,
    methodologyCid: env.WARSAW_VERIFIABLE_METHODOLOGY_CID ?? "ipfs://warsaw-resi-median-v1",
    ruleAddress: env.MEDIAN_RULE as `0x${string}`,
    otodomUrl: env.WARSAW_OTODOM_URL ?? DEFAULT_OTODOM_URL,
  });
  try {
    const result = await agent.attest({
      privateKey: env.PRIVATE_KEY as `0x${string}`,
      rpcUrl: env.RPC_URL,
    });
    log.info("worker: warsaw-verifiable attested", {
      txHash: result.txHash,
      n: result.rawInputs?.length,
    });
  } catch (e) {
    log.error("worker: warsaw-verifiable failed", { error: (e as Error).message });
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
      value: result.value?.toString(),
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
      value: result.value?.toString(),
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
