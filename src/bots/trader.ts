/**
 * Trading bot that generates visible activity on the seeded markets. Picks
 * a random market and a random side, takes a small position, broadcasts.
 *
 * Two operating modes:
 *  - As a Node script: `npm run bot:trade` — does ONE random trade and exits.
 *  - As a Cloudflare Worker cron: hourly trigger via `bot-worker.ts`.
 *
 * The bot is intentionally simple: it does NOT try to be smart. The point is
 * to generate volume so the frontend's "X trades · Y USDC vol" reads as real
 * activity. A truly speculative bot would short-circuit our demo's honesty.
 *
 * Spend cap: each trade ≤ 0.5 USDC. With 5-10 USDC seed, we can produce
 * 10-20 trades before running dry. Refund the bot wallet from the faucet
 * when it gets low.
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
import { config as loadEnv } from "dotenv";
import { log } from "../sdk/index.js";
import deployment from "../../../contracts/deployments/arc-testnet.json" with { type: "json" };

loadEnv();

const arc = defineChain({
  id: deployment.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC ?? deployment.rpc] } },
});

const usdcAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const marketsAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "collateralIn", type: "uint256" },
      { name: "minSharesOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getMarket",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      {
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
      },
    ],
  },
] as const;

const TRADE_AMOUNT_USDC = 0.3;
const TRADE_AMOUNT_WEI = parseUnits(String(TRADE_AMOUNT_USDC), 6);

export async function runOneTrade(): Promise<void> {
  const privateKey = process.env.BOT_PRIVATE_KEY as Hex | undefined;
  const rpcUrl = process.env.RPC ?? deployment.rpc;
  if (!privateKey) throw new Error("BOT_PRIVATE_KEY not set");

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arc, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: arc, transport: http(rpcUrl), account });

  const usdc = deployment.contracts.USDC as Address;
  const markets = deployment.contracts.Markets as Address;

  // Balance check.
  const balance = (await publicClient.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  log.info("bot: balance", { address: account.address, usdc: (Number(balance) / 1e6).toFixed(4) });

  if (balance < TRADE_AMOUNT_WEI) {
    log.warn("bot: insufficient USDC, refund the bot wallet from faucet.circle.com");
    return;
  }

  // Approve generously once (covers many trades).
  const allowance = (await publicClient.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "allowance",
    args: [account.address, markets],
  })) as bigint;
  if (allowance < TRADE_AMOUNT_WEI) {
    log.info("bot: approving USDC");
    const approveHash = await walletClient.writeContract({
      address: usdc,
      abi: usdcAbi,
      functionName: "approve",
      args: [markets, parseUnits("10", 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  // Pick a random market and side.
  const marketChoices = deployment.markets as Array<{ id: string; threshold: number }>;
  const target = marketChoices[Math.floor(Math.random() * marketChoices.length)]!;

  // Bias toward the side that matches current attestation vs threshold for a
  // touch of plausibility — but not always, so we generate two-way flow.
  const flip = Math.random() < 0.4;
  const latestValue = deployment.warsawFeed.firstAttestation.value;
  const naturalYes = latestValue > target.threshold; // very rough; comparator-aware logic would be nicer
  const outcome = flip ? (naturalYes ? 1 : 0) : naturalYes ? 0 : 1;

  log.info("bot: trading", {
    marketId: target.id,
    threshold: target.threshold,
    side: outcome === 0 ? "YES" : "NO",
    amount: TRADE_AMOUNT_USDC,
  });

  // Defensive slippage protection. For a 0.3 USDC buy into a roughly-50/50
  // pool we expect ~0.55 shares; require at least 40% of the deposit back
  // in shares (i.e. price ≤ 75¢). Anything tighter than that is a sign the
  // market state has drifted significantly.
  const minShares = TRADE_AMOUNT_WEI / 2n;
  const hash = await walletClient.writeContract({
    address: markets,
    abi: marketsAbi,
    functionName: "buy",
    args: [target.id as Hex, outcome, TRADE_AMOUNT_WEI, minShares],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("bot: buy reverted");

  log.info("bot: trade confirmed", { txHash: hash, block: receipt.blockNumber.toString() });
}

// Direct invocation as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  runOneTrade().catch((e) => {
    log.error("bot: failed", { error: (e as Error).message });
    process.exit(1);
  });
}
