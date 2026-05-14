/**
 * Market-maker bot. On each tick, prices every market against a target
 * derived from the agent's latest attestation, finds the market furthest
 * from its target, and nudges it with one small trade.
 *
 * v1 model: target YES probability = 0.5 ± shift, where shift grows with
 * (1) relative distance of the feed value from the threshold and (2) how
 * close we are to expiry. Both intuitions hold: the further the feed is
 * from the threshold, the less likely it crosses; the less time remains,
 * the less likely it crosses from where it currently sits.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { attestationAbi, log } from "@registrai/agent-sdk";
import deployment from "../../../contracts/deployments/arc-testnet.json" with { type: "json" };

const TRADE_AMOUNT_USDC = 0.3;
const TRADE_AMOUNT_WEI = parseUnits(String(TRADE_AMOUNT_USDC), 6);
const SPREAD_TOLERANCE = 0.05; // do nothing if pool is within 5pp of target
const MIN_BALANCE_USDC_WEI = parseUnits("2", 6);

type Comparator = "GreaterThan" | "GreaterThanOrEqual" | "LessThan" | "LessThanOrEqual";

const vaultAbi = [
  { type: "function", name: "executeBuy", stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "collateralIn", type: "uint256" },
      { name: "minSharesOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "nav", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const marketsAbi = [
  { type: "function", name: "getMarket", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "feedId", type: "bytes32" },
        { name: "agent", type: "address" },
        { name: "threshold", type: "int256" },
        { name: "comparator", type: "uint8" },
        { name: "expiry", type: "uint256" },
        { name: "creator", type: "address" },
        { name: "yesReserve", type: "uint256" },
        { name: "noReserve", type: "uint256" },
        { name: "phase", type: "uint8" },
        { name: "yesWon", type: "bool" },
        { name: "createdAt", type: "uint256" },
      ],
    }] },
] as const;

export interface MmEnv {
  TRADER_PRIVATE_KEY?: string;
  RPC_URL: string;
}

interface OnchainMarket {
  feedId: Hex;
  agent: Address;
  yesReserve: bigint;
  noReserve: bigint;
  expiry: bigint;
  phase: number;
}

interface MarketSnapshot extends OnchainMarket {
  id: Hex;
  threshold: number;
  comparator: Comparator;
}

interface Scored extends MarketSnapshot {
  currentValue: number;
  pCurrent: number;
  pTarget: number;
  delta: number; // signed: positive means need to push YES up
}

function targetYesProb(
  value: number,
  threshold: number,
  comparator: Comparator,
  daysToExpiry: number,
): number {
  const isGreater = comparator.startsWith("Greater");
  const yesWinning = isGreater ? value > threshold : value < threshold;
  const relDistance = Math.abs(value - threshold) / Math.max(1, Math.abs(threshold));
  const timeFactor = 1 / (1 + Math.max(0, daysToExpiry) / 30);
  const shift = Math.min(0.4, relDistance * 3 * timeFactor);
  return yesWinning ? 0.5 + shift : 0.5 - shift;
}

function poolYesPrice(yesReserve: bigint, noReserve: bigint): number {
  const total = yesReserve + noReserve;
  if (total === 0n) return 0.5;
  return Number(noReserve) / Number(total);
}

export async function runMarketMaker(env: MmEnv): Promise<void> {
  const privateKey = env.TRADER_PRIVATE_KEY as Hex | undefined;
  if (!privateKey) {
    log.warn("mm: TRADER_PRIVATE_KEY not set, skipping");
    return;
  }

  const arc = defineChain({
    id: deployment.chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arc, transport: http(env.RPC_URL) });
  const walletClient = createWalletClient({ chain: arc, transport: http(env.RPC_URL), account });

  const marketsAddr = deployment.contracts.Markets as Address;
  const attestation = deployment.contracts.Attestation as Address;
  const vaultAddr = (deployment.contracts as { MarketMakerVault?: string })
    .MarketMakerVault as Address | undefined;
  if (!vaultAddr) {
    log.warn("mm: MarketMakerVault not configured in deployment manifest, skipping");
    return;
  }

  const vaultNav = (await publicClient.readContract({
    address: vaultAddr, abi: vaultAbi, functionName: "nav",
  })) as bigint;
  log.info("mm: vault nav", { usdc: (Number(vaultNav) / 1e6).toFixed(4) });
  if (vaultNav < MIN_BALANCE_USDC_WEI) {
    log.warn("mm: vault NAV below floor, top up via deposit");
    return;
  }

  // Filter to USDC markets only (we only have USDC on this bot wallet).
  const usdcMarkets = (deployment.markets as Array<{
    id: string; collateral: string; threshold: number; comparator: Comparator;
  }>).filter((m) => m.collateral === "USDC");

  const snapshots: MarketSnapshot[] = await Promise.all(usdcMarkets.map(async (m) => {
    const market = (await publicClient.readContract({
      address: marketsAddr, abi: marketsAbi, functionName: "getMarket", args: [m.id as Hex],
    })) as OnchainMarket;
    return { ...market, id: m.id as Hex, threshold: m.threshold, comparator: m.comparator };
  }));

  // Phase enum on Markets: { Trading=0, Resolved=1 }
  const openMarkets = snapshots.filter((s) => s.phase === 0);
  if (openMarkets.length === 0) {
    log.info("mm: no open markets");
    return;
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const scored: Scored[] = await Promise.all(openMarkets.map(async (s) => {
    const [value] = (await publicClient.readContract({
      address: attestation, abi: attestationAbi as never, functionName: "latestValue" as never,
      args: [s.feedId, s.agent] as never,
    })) as [bigint, bigint, boolean];
    const currentValue = Number(value);
    const daysToExpiry = Number(s.expiry - nowSec) / 86400;
    const pTarget = targetYesProb(currentValue, s.threshold, s.comparator, daysToExpiry);
    const pCurrent = poolYesPrice(s.yesReserve, s.noReserve);
    return { ...s, currentValue, pCurrent, pTarget, delta: pTarget - pCurrent };
  }));

  // Pick the market most off-target.
  scored.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const target = scored[0]!;

  log.info("mm: scored", {
    candidates: scored.map((s) => ({
      id: s.id.slice(0, 10),
      curr: s.pCurrent.toFixed(3),
      tgt: s.pTarget.toFixed(3),
      delta: s.delta.toFixed(3),
    })),
  });

  if (Math.abs(target.delta) < SPREAD_TOLERANCE) {
    log.info("mm: all markets within spread, sitting out");
    return;
  }

  // delta > 0 → need pYES higher → buy YES (outcome=0). delta < 0 → buy NO (outcome=1).
  const outcome = target.delta > 0 ? 0 : 1;
  const minShares = TRADE_AMOUNT_WEI / 2n;

  log.info("mm: trading", {
    marketId: target.id,
    side: outcome === 0 ? "YES" : "NO",
    amount: TRADE_AMOUNT_USDC,
    pCurrent: target.pCurrent.toFixed(3),
    pTarget: target.pTarget.toFixed(3),
  });

  const hash = await walletClient.writeContract({
    address: vaultAddr, abi: vaultAbi, functionName: "executeBuy",
    args: [target.id, outcome, TRADE_AMOUNT_WEI, minShares],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("mm: buy reverted");
  log.info("mm: trade confirmed", { txHash: hash, block: receipt.blockNumber.toString() });
}

// Direct invocation as a script for local dry-run / one-shot.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { config: loadEnv } = await import("dotenv");
  loadEnv();
  runMarketMaker({
    TRADER_PRIVATE_KEY: process.env.BOT_PRIVATE_KEY ?? process.env.TRADER_PRIVATE_KEY,
    RPC_URL: process.env.RPC ?? deployment.rpc,
  }).catch((e) => {
    log.error("mm: failed", { error: (e as Error).message });
    process.exit(1);
  });
}
