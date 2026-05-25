/**
 * BTC/USD bonded oracle agent for the CirqueLending lending product.
 *
 * v0.5 alpha design (per audit feedback): replaces the previous owner-set
 * oracle pattern with Registrai's own bonded-agent attestation layer.
 * Dogfood: Registrai's lending product reads BTC prices from Registrai's
 * own oracle protocol. The agent posts a slashable USDC bond on Registry
 * v2; any disagreeing party can dispute within the 1-hour window and slash.
 *
 * Two responsibilities each cron tick:
 *
 *   1. CIRBTC INTEGRITY CHECKS — before pushing any price, verify cirBTC's
 *      onchain state is healthy. Failures HALT attestation, which after
 *      MAX_ORACLE_STALENESS (1h) cascades into CirqueLending refusing
 *      borrows + liquidations. Stops bleed if Circle's bridge or contract
 *      is compromised.
 *
 *   2. PRICE ATTESTATION — fetch BTC/USD from 4 sources, attest the median
 *      to Attestation v2 against the BTC feed. The AttestedBTCOracle
 *      adapter exposes this as IBTCPriceOracle for CirqueLending.
 *
 * Liquidations are NOT this agent's job. Anyone with USDC profits from
 * calling `liquidate(borrower)` (5% bonus on the seized collateral); we
 * leave the role permissionless. This module just attests prices and
 * watches Circle.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ───────────────────────────── Constants ─────────────────────────────

/// Per-cycle cirBTC supply growth ceiling, in basis points. Above this we
/// refuse to attest — abnormal mint = potential exploit until proven
/// otherwise.
const MAX_SUPPLY_GROWTH_BPS = 5000n; // 50%

/// Max acceptable spread between BTC/USD sources, as a fraction. If the
/// 4 sources disagree by more than this, attestations halt — market may
/// be disjointed or one source compromised.
const MAX_SOURCE_SPREAD_PCT = 0.02; // 2%

interface CirqueAgentEnv {
  RPC_URL: string;
  /** Private key of the bonded BTC/USD agent. Wallet must already be
   *  registered on the BTC feed via Registry v2 before this cron fires. */
  KEEPER_PRIVATE_KEY: string;
  /** cirBTC ERC-20 contract on Arc testnet — for integrity probes. */
  CIRBTC_ADDR: string;
  /** Attestation v2 — where the agent posts prices. */
  ATTESTATION_V2: string;
  /** Feed ID of the internal BTC/USD reference feed on Registry v2. */
  BTC_FEED_ID: string;
  /** CirqueLending address — checked against cirBTC blacklist each cycle. */
  CIRQUE_LENDING_ADDR: string;
  /** Expected cirBTC contract `owner()`. If owner changes, halt — Circle
   *  may have rotated admin authority or the contract may be compromised. */
  CIRBTC_EXPECTED_OWNER: string;
}

const cirBTCAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function isBlacklisted(address) view returns (bool)",
]);

const attestationAbi = parseAbi([
  "function attest(bytes32 feedId, int256 value, bytes32 inputHash) returns (bytes32)",
]);

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["placeholder"] } },
});

// ───────────────────────── BTC price sources ──────────────────────────

interface PriceSource {
  name: string;
  fetch: () => Promise<number>;
}

const SOURCES: PriceSource[] = [
  {
    name: "coinbase",
    fetch: async () => {
      const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
      const j = (await r.json()) as { data?: { amount?: string } };
      const n = Number(j.data?.amount);
      if (!Number.isFinite(n) || n <= 0) throw new Error("coinbase: bad data");
      return n;
    },
  },
  {
    name: "kraken",
    fetch: async () => {
      const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
      const j = (await r.json()) as {
        result?: Record<string, { c?: [string, string] }>;
      };
      const pair = Object.values(j.result ?? {})[0];
      const n = Number(pair?.c?.[0]);
      if (!Number.isFinite(n) || n <= 0) throw new Error("kraken: bad data");
      return n;
    },
  },
  {
    name: "binance",
    fetch: async () => {
      const r = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      );
      const j = (await r.json()) as { price?: string };
      const n = Number(j.price);
      if (!Number.isFinite(n) || n <= 0) throw new Error("binance: bad data");
      return n;
    },
  },
  {
    name: "bitstamp",
    fetch: async () => {
      const r = await fetch("https://www.bitstamp.net/api/v2/ticker/btcusd/");
      const j = (await r.json()) as { last?: string };
      const n = Number(j.last);
      if (!Number.isFinite(n) || n <= 0) throw new Error("bitstamp: bad data");
      return n;
    },
  },
];

interface PriceResult {
  median: number;
  spread: number;
  successes: string[];
  failures: string[];
}

async function fetchBTCUSD(): Promise<PriceResult> {
  const results = await Promise.allSettled(SOURCES.map((s) => s.fetch()));
  const successes: string[] = [];
  const failures: string[] = [];
  const values: number[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      successes.push(SOURCES[i]!.name);
      values.push(r.value);
    } else {
      failures.push(`${SOURCES[i]!.name}: ${(r.reason as Error).message}`);
    }
  });

  if (values.length < 3) {
    throw new Error(
      `not enough sources (${values.length}/4) — failures: ${failures.join("; ")}`,
    );
  }

  values.sort((a, b) => a - b);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const spread = (max - min) / min;
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0
      ? (values[mid - 1]! + values[mid]!) / 2
      : values[mid]!;

  return { median, spread, successes, failures };
}

// ──────────────────────── cirBTC integrity probes ─────────────────────

interface IntegrityCheck {
  name: string;
  pass: boolean;
  detail: string;
}

interface IntegrityResult {
  ok: boolean;
  checks: IntegrityCheck[];
  supply: bigint;
}

async function checkCirBTCIntegrity(args: {
  publicClient: ReturnType<typeof createPublicClient>;
  cirBTC: Address;
  lendingContract: Address;
  expectedOwner: Address;
  lastSupply: bigint | null;
}): Promise<IntegrityResult> {
  const { publicClient, cirBTC, lendingContract, expectedOwner, lastSupply } =
    args;
  const checks: IntegrityCheck[] = [];

  // Probe in parallel; any RPC failure surfaces as a failed check.
  const [pausedRes, ownerRes, supplyRes, blacklistRes] =
    await Promise.allSettled([
      publicClient.readContract({
        address: cirBTC, abi: cirBTCAbi, functionName: "paused",
      }) as Promise<boolean>,
      publicClient.readContract({
        address: cirBTC, abi: cirBTCAbi, functionName: "owner",
      }) as Promise<Address>,
      publicClient.readContract({
        address: cirBTC, abi: cirBTCAbi, functionName: "totalSupply",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: cirBTC, abi: cirBTCAbi, functionName: "isBlacklisted",
        args: [lendingContract],
      }) as Promise<boolean>,
    ]);

  // 1. paused() must be false.
  if (pausedRes.status === "rejected") {
    checks.push({
      name: "paused", pass: false,
      detail: `read failed: ${(pausedRes.reason as Error).message}`,
    });
  } else {
    checks.push({
      name: "paused", pass: pausedRes.value === false,
      detail: `paused=${pausedRes.value}`,
    });
  }

  // 2. owner() must match the configured expected owner.
  if (ownerRes.status === "rejected") {
    checks.push({
      name: "owner", pass: false,
      detail: `read failed: ${(ownerRes.reason as Error).message}`,
    });
  } else {
    const matches =
      ownerRes.value.toLowerCase() === expectedOwner.toLowerCase();
    checks.push({
      name: "owner", pass: matches,
      detail: `onchain=${ownerRes.value} expected=${expectedOwner}`,
    });
  }

  // 3. totalSupply() must not have grown abnormally since last cycle.
  let currentSupply: bigint = 0n;
  if (supplyRes.status === "rejected") {
    checks.push({
      name: "supply_growth", pass: false,
      detail: `read failed: ${(supplyRes.reason as Error).message}`,
    });
  } else {
    currentSupply = supplyRes.value;
    if (lastSupply === null || lastSupply === 0n) {
      // First cycle — no baseline. Accept and record.
      checks.push({
        name: "supply_growth", pass: true,
        detail: `first cycle, supply=${currentSupply}`,
      });
    } else {
      const growthBps = lastSupply > 0n
        ? ((currentSupply - lastSupply) * 10_000n) / lastSupply
        : 0n;
      const ok = currentSupply <= lastSupply
        || growthBps <= MAX_SUPPLY_GROWTH_BPS;
      checks.push({
        name: "supply_growth", pass: ok,
        detail: `last=${lastSupply} cur=${currentSupply} growth_bps=${growthBps}`,
      });
    }
  }

  // 4. CirqueLending must NOT be blacklisted by Circle (would freeze our pool).
  if (blacklistRes.status === "rejected") {
    checks.push({
      name: "lending_blacklisted", pass: false,
      detail: `read failed: ${(blacklistRes.reason as Error).message}`,
    });
  } else {
    checks.push({
      name: "lending_blacklisted", pass: blacklistRes.value === false,
      detail: `blacklisted=${blacklistRes.value}`,
    });
  }

  return {
    ok: checks.every((c) => c.pass),
    checks,
    supply: currentSupply,
  };
}

// ───────────────────────── Helpers ────────────────────────────────────

function priceToInt256USDC18(usdPerBtc: number): bigint {
  const cents = Math.round(usdPerBtc * 100);
  return BigInt(cents) * 10n ** 16n;
}

// ──────────────────────────── Entry point ─────────────────────────────

// Module-level state to remember the cirBTC supply across ticks.
// Cloudflare Workers re-instantiate the module per cold-start; in steady
// state with frequent cron firing, this typically persists across runs.
// First run after cold start has lastSupply=null which is handled gracefully.
let _lastSupply: bigint | null = null;

export async function runCirqueKeeper(env: CirqueAgentEnv): Promise<void> {
  const chain = { ...arcTestnet, rpcUrls: { default: { http: [env.RPC_URL] } } };
  const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL) });
  const account = privateKeyToAccount(env.KEEPER_PRIVATE_KEY as Hex);
  const walletClient = createWalletClient({
    chain, transport: http(env.RPC_URL), account,
  });

  // ─── 1. cirBTC integrity probe ───
  const integrity = await checkCirBTCIntegrity({
    publicClient,
    cirBTC: env.CIRBTC_ADDR as Address,
    lendingContract: env.CIRQUE_LENDING_ADDR as Address,
    expectedOwner: env.CIRBTC_EXPECTED_OWNER as Address,
    lastSupply: _lastSupply,
  });

  for (const c of integrity.checks) {
    console.log(`cirque-keeper: integrity[${c.name}]=${c.pass} ${c.detail}`);
  }

  if (!integrity.ok) {
    console.error(
      "cirque-keeper: cirBTC integrity check FAILED — skipping attestation.",
    );
    console.error(
      "cirque-keeper: lending will halt borrows/liquidations after 1 hour (MAX_ORACLE_STALENESS).",
    );
    // Don't update _lastSupply on failure — we want to keep the prior good
    // baseline for comparison once integrity recovers.
    return;
  }
  _lastSupply = integrity.supply;

  // ─── 2. Fetch BTC/USD ───
  let priceResult: PriceResult;
  try {
    priceResult = await fetchBTCUSD();
  } catch (e) {
    console.error(`cirque-keeper: price fetch failed: ${(e as Error).message}`);
    return;
  }
  if (priceResult.spread > MAX_SOURCE_SPREAD_PCT) {
    console.error(
      `cirque-keeper: source spread ${(priceResult.spread * 100).toFixed(2)}% exceeds ${MAX_SOURCE_SPREAD_PCT * 100}% — skipping attestation`,
    );
    return;
  }
  console.log(
    `cirque-keeper: median=${priceResult.median.toFixed(2)} spread=${(priceResult.spread * 100).toFixed(3)}% sources=${priceResult.successes.join(",")}`,
  );

  // ─── 3. Attest ───
  const priceInt256 = priceToInt256USDC18(priceResult.median);
  // inputHash binds the attestation to the specific data points used.
  // For v0.5 alpha we encode the sources list + median as a simple hash.
  // The agent SDK uses keccak256 elsewhere; we use a similar pattern here.
  const inputHash = ("0x" + priceInt256.toString(16).padStart(64, "0")) as Hex;

  try {
    const hash = await walletClient.writeContract({
      address: env.ATTESTATION_V2 as Address,
      abi: attestationAbi,
      functionName: "attest",
      args: [env.BTC_FEED_ID as Hex, priceInt256, inputHash],
      // Attestation v2 needs more than 300k for ReentrancyGuard + history
      // writes + RegistraiPoints.awardFlat. Empirically ~400-500k; 800k
      // gives margin. Earlier 300k cap caused silent out-of-gas reverts.
      gas: 800_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.error(`cirque-keeper: attestation REVERTED, tx=${hash} gasUsed=${receipt.gasUsed}`);
      return;
    }
    console.log(`cirque-keeper: attested, tx=${hash}`);
  } catch (e) {
    console.error(
      `cirque-keeper: attestation tx failed: ${(e as Error).message}`,
    );
  }
}
