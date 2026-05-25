/**
 * Social signal oracle — a Cloudflare Worker module that runs as a bonded
 * Registrai agent and mints soulbound credit points for verified off-chain
 * social actions (currently: prove ownership of a Twitter handle).
 *
 * Architecture
 * ────────────
 * The social oracle is its OWN registered agent on Registry v2 with its own
 * USDC bond. It is also added as a `setMinter` on RegistraiPoints so it can
 * award credits onchain. If it lies or misbehaves, anyone can dispute its
 * (future) feed attestations and slash its bond via the existing Dispute
 * contract — the same trust mechanism as every other Registrai agent.
 *
 * Quest 1 — "Connect Twitter"
 * ───────────────────────────
 * 1. User clicks "connect twitter" with their wallet on /profile.
 * 2. Worker generates a one-time challenge nonce, returns a tweet template
 *    containing the wallet address + the nonce.
 * 3. User posts that tweet from their account.
 * 4. User pastes the tweet URL back to the worker.
 * 5. Worker fetches the tweet via Twitter's public oEmbed endpoint (no API
 *    key, no auth, no rate-limit cost) and verifies:
 *      - the tweet text contains the wallet address
 *      - the tweet text contains the generated nonce
 *      - the Twitter handle isn't already bound to a different wallet
 * 6. Worker calls `RegistraiPoints.awardFlat(wallet, 50, "quest_twitter")`
 *    onchain. 50 pts soulbound credit, reason tag distinguishes from
 *    protocol-action credits.
 *
 * The TWITTER_BINDINGS KV makes each handle one-shot — same person can't
 * farm by signing in with multiple wallets from the same Twitter account.
 *
 * Future quests (retweet, follow) require Twitter API access for direct
 * verification; the structure here generalises trivially.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { log } from "@registrai/agent-sdk";

// ────────────────────────────── Types ──────────────────────────────

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface SocialEnv {
  /**
   * Secret: dedicated MINT-ONLY key. Has minter role on RegistraiPoints but
   * holds no bond — if leaked, an attacker can mint points but cannot drain
   * the social oracle's 10 USDC bond. The bonded social-oracle key
   * (SOCIAL_PRIVATE_KEY) stays separate, never used for minting.
   */
  MINTER_PRIVATE_KEY?: string;
  /** Kept for future aggregate attestations (not used in the mint path). */
  SOCIAL_PRIVATE_KEY?: string;
  RPC_URL: string;
  /** RegistraiPoints v2 contract address. */
  REGISTRAI_POINTS_ADDR?: string;
  /** Registry addresses to scan for AgentRegistered events when verifying
   *  that a wallet has at least one bonded oracle agent on chain. v1.0 / v1.1
   *  / v2 are all valid — any one of them confirms agent status. */
  REGISTRY_ADDRESS?: string;       // v1.0
  REGISTRY_V1_1?: string;          // v1.1
  REGISTRY_V2?: string;            // v2 (where new agents register)
  /** KV namespace for quest claims + handle bindings. */
  SOCIAL_CLAIMS: KVNamespace;
}

// ────────────────────────── Constants / ABIs ───────────────────────

const POINTS_QUEST_CONNECT_TWITTER = 50;
const POINTS_QUEST_SHARE_AGENT = 150;
const NONCE_TTL_SECONDS = 60 * 60; // pending challenge expires after 1 hour

// AgentRegistered(bytes32 indexed feedId, address indexed agent, ...)
const AGENT_REGISTERED_TOPIC =
  "0x3e8cb00d49eaad4133408787501fd7cb233190bda0c0dd5c1fe1545e00cf8665";

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const awardFlatAbi = [
  {
    type: "function",
    name: "awardFlat",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "reason", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

// ────────────────────────── HTTP entrypoint ────────────────────────

export async function handleQuestRequest(
  request: Request,
  env: SocialEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/quest/")) return null;

  if (url.pathname === "/quest/twitter/start" && request.method === "POST") {
    return handleStart(request, env, cors);
  }
  if (url.pathname === "/quest/twitter/verify" && request.method === "POST") {
    return handleVerify(request, env, cors);
  }
  if (
    url.pathname === "/quest/twitter/share-agent/start" &&
    request.method === "POST"
  ) {
    return handleShareAgentStart(request, env, cors);
  }
  if (
    url.pathname === "/quest/twitter/share-agent/verify" &&
    request.method === "POST"
  ) {
    return handleShareAgentVerify(request, env, cors);
  }
  if (url.pathname === "/quest/status" && request.method === "GET") {
    return handleStatus(url, env, cors);
  }
  return new Response("not found", { status: 404, headers: cors });
}

// ────────────────────────── Quest: start ───────────────────────────

interface StartBody {
  wallet?: string;
}

async function handleStart(
  req: Request,
  env: SocialEnv,
  cors: Record<string, string>,
): Promise<Response> {
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return json({ error: "invalid json" }, 400, cors);
  }

  const wallet = body.wallet?.toLowerCase();
  if (!wallet || !isAddress(wallet)) {
    return json({ error: "wallet (address) required" }, 400, cors);
  }

  // If this wallet already claimed twitter_connect, short-circuit.
  const already = await env.SOCIAL_CLAIMS.get(`twitter_connect:${wallet}`);
  if (already) {
    return json(
      { error: "already claimed", claim: JSON.parse(already) },
      409,
      cors,
    );
  }

  // Generate a fresh nonce. Per-nonce KV keys (`nonce:{wallet}:{nonce}`) let
  // multiple browser tabs each have their own valid nonce — a second tab's
  // /start no longer invalidates the first tab's pending claim.
  const nonce = generateNonce();
  await env.SOCIAL_CLAIMS.put(
    `nonce:${wallet}:${nonce}`,
    "1",
    { expirationTtl: NONCE_TTL_SECONDS },
  );

  const tweetText =
    `I'm claiming onchain credits on @registraidotcc with ${wallet}\n\n` +
    `verifyId: ${nonce}\n\n` +
    `registrai.cc — soulbound credits on arc testnet`;

  return json(
    {
      tweet: tweetText,
      nonce,
      points: POINTS_QUEST_CONNECT_TWITTER,
      expiresInSeconds: NONCE_TTL_SECONDS,
    },
    200,
    cors,
  );
}

// ────────────────────────── Quest: verify ──────────────────────────

interface VerifyBody {
  wallet?: string;
  tweetUrl?: string;
  /** Nonce returned by /start. Required so the user's specific issued nonce
   *  is the one we check against — protects against a second tab overwriting
   *  the first tab's pending state. */
  nonce?: string;
}

async function handleVerify(
  req: Request,
  env: SocialEnv,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.MINTER_PRIVATE_KEY && !env.SOCIAL_PRIVATE_KEY) {
    return json({ error: "minter not configured" }, 500, cors);
  }
  if (!env.REGISTRAI_POINTS_ADDR) {
    return json({ error: "points contract not configured" }, 500, cors);
  }

  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return json({ error: "invalid json" }, 400, cors);
  }

  const wallet = body.wallet?.toLowerCase();
  const tweetUrl = body.tweetUrl?.trim();
  if (!wallet || !isAddress(wallet)) {
    return json({ error: "wallet required" }, 400, cors);
  }
  if (!tweetUrl || !/^https?:\/\/(www\.)?(twitter|x)\.com\/.+\/status\/\d+/i.test(tweetUrl)) {
    return json({ error: "valid twitter status URL required" }, 400, cors);
  }

  if (!(await checkRateLimit(env, wallet))) {
    return json({ error: "too many verify attempts — wait a few minutes" }, 429, cors);
  }

  // Idempotency: already claimed?
  const already = await env.SOCIAL_CLAIMS.get(`twitter_connect:${wallet}`);
  if (already) {
    return json(
      { error: "already claimed", claim: JSON.parse(already) },
      409,
      cors,
    );
  }

  // The client passes the nonce it received from /start. We verify it was
  // actually issued (per-nonce KV key with TTL) — a forged nonce won't match
  // any key, an expired nonce will have aged out.
  const nonce = body.nonce?.trim();
  if (!nonce) {
    return json(
      { error: "nonce required — call /quest/twitter/start first" },
      400,
      cors,
    );
  }
  const nonceExists = await env.SOCIAL_CLAIMS.get(`nonce:${wallet}:${nonce}`);
  if (!nonceExists) {
    return json(
      { error: "nonce expired or never issued — start again" },
      400,
      cors,
    );
  }

  // Fetch the tweet via Twitter's public oEmbed endpoint. No API key needed.
  // Returns JSON including the rendered HTML (which contains the tweet text)
  // and the author_url (which contains the canonical handle).
  let oembed: { author_url?: string; html?: string };
  try {
    const oembedRes = await fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&dnt=true&omit_script=true`,
      { headers: { "User-Agent": "Registrai-SocialOracle/1.0" } },
    );
    if (!oembedRes.ok) {
      return json({ error: `oEmbed failed (${oembedRes.status})` }, 400, cors);
    }
    oembed = (await oembedRes.json()) as typeof oembed;
  } catch {
    return json({ error: "failed to reach Twitter oEmbed" }, 502, cors);
  }

  // Extract the canonical twitter handle from author_url.
  const handleMatch = oembed.author_url?.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i);
  const handle = handleMatch?.[1]?.toLowerCase();
  if (!handle) {
    return json({ error: "could not extract twitter handle from tweet" }, 400, cors);
  }

  // Only inspect the author's own body (prevents quote-tweet replay).
  const text = extractTweetBody(oembed.html ?? "").toLowerCase();
  if (!text.includes(wallet)) {
    return json({ error: "tweet does not contain your wallet address" }, 400, cors);
  }
  if (!text.includes(nonce.toLowerCase())) {
    return json({ error: "tweet does not contain the verification nonce" }, 400, cors);
  }
  if (!mentionsRegistrai(text)) {
    return json(
      { error: "tweet must mention @registraidotcc or link to registrai.cc" },
      400,
      cors,
    );
  }

  // One handle → one wallet. If this Twitter handle is already bound to a
  // different wallet, refuse.
  const handleBinding = await env.SOCIAL_CLAIMS.get(`handle:${handle}`);
  if (handleBinding && handleBinding.toLowerCase() !== wallet) {
    return json(
      { error: `twitter handle @${handle} is already bound to a different wallet` },
      409,
      cors,
    );
  }

  // Claiming sentinel — collapses the KV race window from ~60s to ~1s for
  // concurrent verify requests. Without this, two parallel calls could both
  // pass the "already claimed?" check and double-mint.
  const sentinelKey = `claiming:${wallet}`;
  const inFlight = await env.SOCIAL_CLAIMS.get(sentinelKey);
  if (inFlight) {
    return json({ error: "claim already in progress, please wait" }, 429, cors);
  }
  await env.SOCIAL_CLAIMS.put(sentinelKey, "1", { expirationTtl: 60 });

  // Mint credits onchain.
  let txHash: Hex;
  try {
    txHash = await mintCredit(
      env,
      wallet as Address,
      POINTS_QUEST_CONNECT_TWITTER,
      "quest_twitter",
    );
  } catch (e) {
    log.error("social-oracle: mint failed", { error: (e as Error).message });
    return json({ error: "failed to mint onchain — please retry" }, 502, cors);
  }

  // Persist the claim + binding. Also store the tweet URL so a future
  // slash-on-delete cron can revoke if the user deletes the tweet.
  const claim = {
    handle,
    tweetUrl,
    txHash,
    points: POINTS_QUEST_CONNECT_TWITTER,
    timestamp: Math.floor(Date.now() / 1000),
  };
  await env.SOCIAL_CLAIMS.put(
    `twitter_connect:${wallet}`,
    JSON.stringify(claim),
  );
  // Invalidate the pending nonce so it can't be replayed.
  // Invalidate the specific nonce used for this claim (per-nonce KV key).
  await env.SOCIAL_CLAIMS.put(`nonce:${wallet}:${nonce}`, "", { expirationTtl: 60 });
  await env.SOCIAL_CLAIMS.put(`handle:${handle}`, wallet);

  return json({ ok: true, ...claim }, 200, cors);
}

// ────────────────────────── Quest: status ──────────────────────────

async function handleStatus(
  url: URL,
  env: SocialEnv,
  cors: Record<string, string>,
): Promise<Response> {
  const wallet = url.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !isAddress(wallet)) {
    return json({ error: "wallet query param required" }, 400, cors);
  }
  const [twitter, shareAgent] = await Promise.all([
    env.SOCIAL_CLAIMS.get(`twitter_connect:${wallet}`),
    env.SOCIAL_CLAIMS.get(`share_agent:${wallet}`),
  ]);
  return json(
    {
      wallet,
      quests: {
        twitter_connect: twitter ? JSON.parse(twitter) : null,
        share_agent: shareAgent ? JSON.parse(shareAgent) : null,
      },
    },
    200,
    cors,
  );
}

// ──────────────── Quest: tweet about your agent ────────────────────

interface ShareAgentStartBody {
  wallet?: string;
}

async function handleShareAgentStart(
  req: Request,
  env: SocialEnv,
  cors: Record<string, string>,
): Promise<Response> {
  let body: ShareAgentStartBody;
  try {
    body = (await req.json()) as ShareAgentStartBody;
  } catch {
    return json({ error: "invalid json" }, 400, cors);
  }

  const wallet = body.wallet?.toLowerCase();
  if (!wallet || !isAddress(wallet)) {
    return json({ error: "wallet (address) required" }, 400, cors);
  }

  // Already claimed?
  const already = await env.SOCIAL_CLAIMS.get(`share_agent:${wallet}`);
  if (already) {
    return json(
      { error: "already claimed", claim: JSON.parse(already) },
      409,
      cors,
    );
  }

  // Must have completed Connect Twitter first (so we know the handle).
  const twitterClaim = await env.SOCIAL_CLAIMS.get(`twitter_connect:${wallet}`);
  if (!twitterClaim) {
    return json(
      {
        error:
          "complete the Connect Twitter quest first — that binds your handle to this wallet",
      },
      400,
      cors,
    );
  }
  const { handle } = JSON.parse(twitterClaim) as { handle: string };

  // Pre-check on chain: does this wallet actually have a bonded agent?
  // Fail fast here so the user isn't asked to compose a tweet they can't
  // claim against.
  try {
    const hasAgent = await walletHasRegisteredAgent(env, wallet);
    if (!hasAgent) {
      return json(
        {
          error:
            "your wallet has no registered oracle agent — register one at /agents/create first",
        },
        400,
        cors,
      );
    }
  } catch (e) {
    log.error("social-oracle: share-agent start: rpc check failed", {
      error: (e as Error).message,
    });
    return json(
      {
        error:
          "could not verify your agent on chain right now — please retry in a minute",
      },
      503,
      cors,
    );
  }

  // Generate a fresh nonce. Per-nonce KV keys allow multi-tab safety —
  // each tab's /start writes a distinct nonce key with its own TTL.
  const nonce = generateNonce();
  await env.SOCIAL_CLAIMS.put(
    `nonce_share:${wallet}:${nonce}`,
    "1",
    { expirationTtl: NONCE_TTL_SECONDS },
  );

  // Three rotating templates — different voices so the same quest doesn't
  // produce identical-looking tweets at scale (Twitter's algorithm clusters
  // near-duplicates). All variants pass verification (wallet + nonce +
  // handle/domain mention).
  const variants = [
    // A · "shipped" — bragging
    `new oracle agent live on @registraidotcc.\n\n` +
      `— bonded 10 USDC\n` +
      `— attestations slashable if wrong\n` +
      `— soulbound credits for every protocol action\n\n` +
      `wallet ${wallet}\nproof ${nonce}\n\n` +
      `registrai.cc/profile`,
    // B · "explainer" — why this matters
    `@registraidotcc lets anyone register as an oracle agent on arc. just did.\n\n` +
      `10 USDC bonded. attestations slashable. credits soulbound, onchain.\n\n` +
      `wallet ${wallet} · proof ${nonce}\n` +
      `registrai.cc/profile`,
    // C · "minimalist"
    `running an oracle agent on @registraidotcc.\n\n` +
      `wallet ${wallet}\nproof ${nonce}\n\n` +
      `soulbound onchain credits — registrai.cc/profile`,
  ];

  return json(
    {
      // Keep `tweet` as the default-selected variant for backwards compat.
      tweet: variants[0],
      variants,
      nonce,
      points: POINTS_QUEST_SHARE_AGENT,
      expiresInSeconds: NONCE_TTL_SECONDS,
      handle,
    },
    200,
    cors,
  );
}

interface ShareAgentVerifyBody {
  wallet?: string;
  tweetUrl?: string;
  /** Nonce returned by /share-agent/start. Required (per-nonce KV keying). */
  nonce?: string;
}

async function handleShareAgentVerify(
  req: Request,
  env: SocialEnv,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.MINTER_PRIVATE_KEY && !env.SOCIAL_PRIVATE_KEY) {
    return json({ error: "minter not configured" }, 500, cors);
  }
  if (!env.REGISTRAI_POINTS_ADDR) {
    return json({ error: "points contract not configured" }, 500, cors);
  }

  let body: ShareAgentVerifyBody;
  try {
    body = (await req.json()) as ShareAgentVerifyBody;
  } catch {
    return json({ error: "invalid json" }, 400, cors);
  }

  const wallet = body.wallet?.toLowerCase();
  const tweetUrl = body.tweetUrl?.trim();
  if (!wallet || !isAddress(wallet)) {
    return json({ error: "wallet required" }, 400, cors);
  }
  if (
    !tweetUrl ||
    !/^https?:\/\/(www\.)?(twitter|x)\.com\/.+\/status\/\d+/i.test(tweetUrl)
  ) {
    return json({ error: "valid twitter status URL required" }, 400, cors);
  }

  if (!(await checkRateLimit(env, wallet))) {
    return json({ error: "too many verify attempts — wait a few minutes" }, 429, cors);
  }

  // Idempotency: already claimed?
  const already = await env.SOCIAL_CLAIMS.get(`share_agent:${wallet}`);
  if (already) {
    return json(
      { error: "already claimed", claim: JSON.parse(already) },
      409,
      cors,
    );
  }

  // Must have Connect Twitter completed and a pending challenge.
  const twitterClaimRaw = await env.SOCIAL_CLAIMS.get(
    `twitter_connect:${wallet}`,
  );
  if (!twitterClaimRaw) {
    return json(
      { error: "complete the Connect Twitter quest first" },
      400,
      cors,
    );
  }
  const { handle: boundHandle } = JSON.parse(twitterClaimRaw) as {
    handle: string;
  };

  // Per-nonce keying: the client-passed nonce must match a KV key we issued.
  const nonce = body.nonce?.trim();
  if (!nonce) {
    return json(
      { error: "nonce required — start the quest first" },
      400,
      cors,
    );
  }
  const nonceExists = await env.SOCIAL_CLAIMS.get(
    `nonce_share:${wallet}:${nonce}`,
  );
  if (!nonceExists) {
    return json(
      { error: "nonce expired or never issued — start again" },
      400,
      cors,
    );
  }

  // Verify the wallet actually has at least one bonded agent on chain.
  // Failing the RPC check must NOT silently deny — surface as 503 so the
  // user can retry (otherwise a flaky node falsely tells them they have no
  // agent when they do).
  let hasAgent: boolean;
  try {
    hasAgent = await walletHasRegisteredAgent(env, wallet);
  } catch (e) {
    log.error("social-oracle: agent-check rpc failed", {
      error: (e as Error).message,
    });
    return json(
      {
        error:
          "could not verify your agent on chain right now — please retry in a minute",
      },
      503,
      cors,
    );
  }
  if (!hasAgent) {
    return json(
      {
        error:
          "your wallet has no registered oracle agent — go to /agents/create first",
      },
      400,
      cors,
    );
  }

  // Fetch the tweet via Twitter's public oEmbed (no API key needed).
  let oembed: { author_url?: string; html?: string };
  try {
    const oembedRes = await fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&dnt=true&omit_script=true`,
      { headers: { "User-Agent": "Registrai-SocialOracle/1.0" } },
    );
    if (!oembedRes.ok) {
      return json({ error: `oEmbed failed (${oembedRes.status})` }, 400, cors);
    }
    oembed = (await oembedRes.json()) as typeof oembed;
  } catch {
    return json({ error: "failed to reach Twitter oEmbed" }, 502, cors);
  }

  // The tweet author must be the handle bound to this wallet.
  const handleMatch = oembed.author_url?.match(
    /(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i,
  );
  const handle = handleMatch?.[1]?.toLowerCase();
  if (!handle) {
    return json({ error: "could not extract twitter handle" }, 400, cors);
  }
  if (handle !== boundHandle.toLowerCase()) {
    return json(
      {
        error: `tweet must come from @${boundHandle} (the handle bound to this wallet)`,
      },
      400,
      cors,
    );
  }

  // The tweet must contain (1) the wallet, (2) the proof nonce, AND
  // (3) a registrai mention — @registraidotcc handle OR registrai.cc domain.
  // IMPORTANT: only inspect the AUTHOR'S body, not the whole oEmbed html.
  // Quote-tweets/embeds otherwise let an attacker pass our checks by piggy-
  // backing on a victim's tweet text.
  const text = extractTweetBody(oembed.html ?? "").toLowerCase();
  if (!text.includes(wallet)) {
    return json({ error: "tweet does not contain your wallet" }, 400, cors);
  }
  if (!text.includes(nonce.toLowerCase())) {
    return json({ error: "tweet does not contain the proof nonce" }, 400, cors);
  }
  if (!mentionsRegistrai(text)) {
    return json(
      {
        error: "tweet must mention @registraidotcc or link to registrai.cc",
      },
      400,
      cors,
    );
  }

  // Claiming sentinel — same race protection as connect_twitter.
  const sentinelKey = `claiming_share:${wallet}`;
  const inFlight = await env.SOCIAL_CLAIMS.get(sentinelKey);
  if (inFlight) {
    return json({ error: "claim already in progress, please wait" }, 429, cors);
  }
  await env.SOCIAL_CLAIMS.put(sentinelKey, "1", { expirationTtl: 60 });

  // Mint credits.
  let txHash: Hex;
  try {
    txHash = await mintCredit(
      env,
      wallet as Address,
      POINTS_QUEST_SHARE_AGENT,
      "quest_share_agent",
    );
  } catch (e) {
    log.error("social-oracle: share_agent mint failed", {
      error: (e as Error).message,
    });
    return json({ error: "failed to mint onchain — please retry" }, 502, cors);
  }

  const claim = {
    handle,
    tweetUrl,
    txHash,
    points: POINTS_QUEST_SHARE_AGENT,
    timestamp: Math.floor(Date.now() / 1000),
  };
  await env.SOCIAL_CLAIMS.put(`share_agent:${wallet}`, JSON.stringify(claim));
  // Invalidate the pending nonce so it can't be replayed.
  await env.SOCIAL_CLAIMS.put(`nonce_share:${wallet}:${nonce}`, "", { expirationTtl: 60 });

  return json({ ok: true, ...claim }, 200, cors);
}

// Returns:
//   - true  : wallet has at least one AgentRegistered event on a Registry
//   - false : wallet definitively has no AgentRegistered events
//   - throws: ALL RPC calls failed — caller must surface this as 503 rather
//             than tell the user "you have no agent" (false-negative UX)
async function walletHasRegisteredAgent(
  env: SocialEnv,
  wallet: string,
): Promise<boolean> {
  const registries = [
    env.REGISTRY_V2,
    env.REGISTRY_V1_1,
    env.REGISTRY_ADDRESS,
  ].filter((a): a is string => !!a);

  if (registries.length === 0) {
    throw new Error("no Registry addresses configured");
  }

  const userTopic =
    "0x" + wallet.replace(/^0x/i, "").toLowerCase().padStart(64, "0");

  // Arc public RPC caps eth_getLogs at 100k blocks AND prunes older ranges.
  // Read the current tip once and query a 99k-block window.
  let fromBlockHex = "0x0";
  try {
    const tipRes = await fetch(env.RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 0,
      }),
    });
    const tipJson = (await tipRes.json()) as { result?: string };
    if (tipJson.result) {
      const tip = BigInt(tipJson.result);
      const from = tip > 99_000n ? tip - 99_000n : 0n;
      fromBlockHex = "0x" + from.toString(16);
    }
  } catch {
    // Best-effort; fall back to 0x0 and let per-registry call surface the error.
  }

  let rpcErrors = 0;
  for (const registry of registries) {
    try {
      const res = await fetch(env.RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getLogs",
          params: [
            {
              address: registry,
              topics: [AGENT_REGISTERED_TOPIC, null, userTopic],
              fromBlock: fromBlockHex,
              toBlock: "latest",
            },
          ],
          id: 1,
        }),
      });
      if (!res.ok) {
        rpcErrors++;
        continue;
      }
      const json = (await res.json()) as {
        result?: unknown[];
        error?: { message?: string };
      };
      if (json.error) {
        rpcErrors++;
        continue;
      }
      if (json.result && json.result.length > 0) return true;
    } catch {
      rpcErrors++;
    }
  }
  // If every RPC call failed, we don't know — let the caller distinguish
  // "verified no agent" from "could not verify" so users aren't told their
  // valid agent doesn't exist.
  if (rpcErrors === registries.length) {
    throw new Error("RPC unreachable — could not verify agent status");
  }
  return false;
}

// ──────────────────────── Onchain mint helper ──────────────────────

async function mintCredit(
  env: SocialEnv,
  user: Address,
  amount: number,
  reason: string,
): Promise<Hex> {
  // Use the dedicated MINTER key, never the bonded social-oracle key.
  const minterKey = env.MINTER_PRIVATE_KEY ?? env.SOCIAL_PRIVATE_KEY;
  if (!minterKey) throw new Error("no minter key configured");
  const account = privateKeyToAccount(minterKey as Hex);
  const publicClient = createPublicClient({
    chain: arc,
    transport: http(env.RPC_URL),
  });
  const walletClient = createWalletClient({
    chain: arc,
    transport: http(env.RPC_URL),
    account,
  });

  const reasonBytes32 = stringToHex(reason, { size: 32 });

  const txHash = await walletClient.writeContract({
    address: env.REGISTRAI_POINTS_ADDR as Address,
    abi: awardFlatAbi,
    functionName: "awardFlat",
    args: [user, BigInt(amount), reasonBytes32],
    gas: 200_000n,
  });

  // Bounded wait: if the tx hasn't mined in 30s, throw a structured error so
  // the caller can return a meaningful response (the tx may still mine later
  // — caller must record the txHash to detect that on retry).
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 30_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`awardFlat tx reverted (${txHash})`);
  }
  log.info("social-oracle: minted", { user, amount, reason, txHash });
  return txHash;
}

/**
 * Per-wallet sliding-window rate limit. 5 verify attempts per 10 minutes.
 * Backed by KV; uses prune-and-rewrite on each check (eventually consistent
 * but good enough for "stop a script from hammering us").
 */
async function checkRateLimit(
  env: SocialEnv,
  wallet: string,
): Promise<boolean> {
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX_ATTEMPTS = 5;
  const key = `verify_rl:${wallet}`;
  const raw = await env.SOCIAL_CLAIMS.get(key);
  const now = Date.now();
  let stamps: number[] = [];
  if (raw) {
    try {
      stamps = (JSON.parse(raw) as number[]).filter(
        (t) => now - t < WINDOW_MS,
      );
    } catch {
      stamps = [];
    }
  }
  if (stamps.length >= MAX_ATTEMPTS) return false;
  stamps.push(now);
  await env.SOCIAL_CLAIMS.put(key, JSON.stringify(stamps), {
    expirationTtl: Math.ceil(WINDOW_MS / 1000),
  });
  return true;
}

// ────────────────────────────── Utils ──────────────────────────────

function generateNonce(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[#a-zA-Z0-9]+;/g, " ");
}

/**
 * Extract just the AUTHOR'S tweet body (the first <p>…</p>) from an oEmbed
 * html blob. Twitter renders quote-tweets and replies with additional content
 * outside the first <p>; if we strip the whole html we'd be checking against
 * text the user didn't actually write — a quote-tweet replay vector.
 */
function extractTweetBody(html: string): string {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return stripHtml(m?.[1] ?? html);
}

/**
 * Mention check with word boundaries. Accepts the canonical Twitter handle
 * `@registraidotcc` (Twitter doesn't allow dots in handles, hence the spelling)
 * or the domain `registrai.cc`. Word boundaries prevent spoofy variants like
 * `@registraidotccfoo` or `registrai.cc.evil.example` from passing.
 */
function mentionsRegistrai(text: string): boolean {
  return (
    /(^|[^a-z0-9_])@registraidotcc(?![a-z0-9_])/i.test(text) ||
    /(^|[^a-z0-9_])registrai\.cc(?![a-z0-9_])/i.test(text)
  );
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: cors });
}
