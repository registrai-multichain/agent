/**
 * End-to-end resolve test on Arc testnet. Spins up a throwaway feed with
 * a 60-second dispute window, registers the operator as the feed's agent,
 * attests a value, creates a market against it, has the vault buy YES,
 * waits for expiry + dispute window, resolves, redeems, and verifies the
 * vault NAV actually grew from a winning bet.
 *
 * This validates the resolution path live, complementing the Foundry
 * full-cycle test which covered the same logic in simulation.
 */
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256,
  encodePacked, parseUnits, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { log } from "@registrai/agent-sdk";
import { config as loadEnv } from "dotenv";
import deployment from "../../../contracts/deployments/arc-testnet.json" with { type: "json" };

loadEnv();
loadEnv({ path: ".env.bot", override: true });

// Registry enforces MIN_DISPUTE_WINDOW=1h and MIN_BOND=10 USDC. Realistic
// live test runtime is ~1 hour from start to redeem.
const DISPUTE_WINDOW_SEC = 3600;
const MARKET_EXPIRY_OFFSET_SEC = 60;
const MIN_BOND = parseUnits("10", 6);
const SEED_LIQUIDITY = parseUnits("2", 6);
const BUY_AMOUNT = parseUnits("0.5", 6);

const registryAbi = [
  { type: "function", name: "createFeed", stateMutability: "nonpayable",
    inputs: [
      { name: "description", type: "string" },
      { name: "methodologyHash", type: "bytes32" },
      { name: "minBond", type: "uint256" },
      { name: "disputeWindow", type: "uint256" },
      { name: "resolver", type: "address" },
    ],
    outputs: [{ type: "bytes32" }] },
  { type: "function", name: "registerAgent", stateMutability: "nonpayable",
    inputs: [
      { name: "feedId", type: "bytes32" },
      { name: "agentMethodologyHash", type: "bytes32" },
      { name: "bondAmount", type: "uint256" },
    ],
    outputs: [] },
] as const;

const attestationAbi = [
  { type: "function", name: "attest", stateMutability: "nonpayable",
    inputs: [
      { name: "feedId", type: "bytes32" },
      { name: "value", type: "int256" },
      { name: "inputHash", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }] },
] as const;

const marketsAbi = [
  { type: "function", name: "createMarket", stateMutability: "nonpayable",
    inputs: [
      { name: "feedId", type: "bytes32" },
      { name: "agent", type: "address" },
      { name: "threshold", type: "int256" },
      { name: "comparator", type: "uint8" },
      { name: "expiry", type: "uint256" },
      { name: "liquidity", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }] },
  { type: "function", name: "resolve", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "getMarket", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
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
    ] }] },
  { type: "function", name: "yesBalance", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "user", type: "address" }],
    outputs: [{ type: "uint256" }] },
] as const;

const vaultAbi = [
  { type: "function", name: "executeBuy", stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "collateralIn", type: "uint256" },
      { name: "minSharesOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "redeem", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nav", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const usdcAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }],
    outputs: [{ type: "bool" }] },
] as const;

async function main() {
  const privateKey = (process.env.BOT_PRIVATE_KEY ?? process.env.TRADER_PRIVATE_KEY) as Hex;
  const rpcUrl = process.env.RPC ?? deployment.rpc;
  const arc = defineChain({
    id: deployment.chainId, name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arc, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: arc, transport: http(rpcUrl), account });

  const registry = deployment.contracts.Registry as Address;
  const attestation = deployment.contracts.Attestation as Address;
  const marketsAddr = deployment.contracts.Markets as Address;
  const usdc = deployment.contracts.USDC as Address;
  const vault = (deployment.contracts as { MarketMakerVault?: string })
    .MarketMakerVault as Address;

  const wait = async (h: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`tx ${h} reverted`);
    return r;
  };

  // 1. Create a short-dispute throwaway feed.
  const methodHash = keccak256(encodePacked(["string"], [`resolve-test-${Date.now()}`]));
  log.info("resolve-test: 1/8 createFeed");
  const h1 = await walletClient.writeContract({
    address: registry, abi: registryAbi, functionName: "createFeed",
    args: [`resolve test ${Date.now()}`, methodHash, MIN_BOND, BigInt(DISPUTE_WINDOW_SEC), account.address],
  });
  const r1 = await wait(h1);
  // Pull feedId from FeedCreated event topic[1].
  const feedId = r1.logs[0]!.topics[1]! as Hex;
  log.info("resolve-test: feedId", { feedId });

  // 2. Approve Registry for bond, register operator as agent.
  log.info("resolve-test: 2/8 approve+registerAgent");
  await wait(await walletClient.writeContract({
    address: usdc, abi: usdcAbi, functionName: "approve", args: [registry, MIN_BOND],
  }));
  await wait(await walletClient.writeContract({
    address: registry, abi: registryAbi, functionName: "registerAgent",
    args: [feedId, methodHash, MIN_BOND],
  }));

  // 3. Attest a value of 17500 (will eventually resolve YES against threshold 17000).
  log.info("resolve-test: 3/8 attest 17500");
  const attHash = await walletClient.writeContract({
    address: attestation, abi: attestationAbi, functionName: "attest",
    args: [feedId, 17500n, keccak256(encodePacked(["int256"], [17500n]))],
  });
  await wait(attHash);

  // 4. Approve Markets and create market.
  const expiry = BigInt(Math.floor(Date.now() / 1000) + MARKET_EXPIRY_OFFSET_SEC);
  log.info("resolve-test: 4/8 approve+createMarket", { expiry: expiry.toString() });
  await wait(await walletClient.writeContract({
    address: usdc, abi: usdcAbi, functionName: "approve",
    args: [marketsAddr, SEED_LIQUIDITY],
  }));
  const mkHash = await walletClient.writeContract({
    address: marketsAddr, abi: marketsAbi, functionName: "createMarket",
    args: [feedId, account.address, 17000n, 0, expiry, SEED_LIQUIDITY],
  });
  const mkRcpt = await wait(mkHash);
  const marketId = mkRcpt.logs[0]!.topics[1]! as Hex;
  log.info("resolve-test: marketId", { marketId });

  // 5. Vault buys YES.
  const navBefore = (await publicClient.readContract({
    address: vault, abi: vaultAbi, functionName: "nav",
  })) as bigint;
  log.info("resolve-test: 5/8 vault.executeBuy YES", {
    nav: (Number(navBefore) / 1e6).toFixed(4),
  });
  await wait(await walletClient.writeContract({
    address: vault, abi: vaultAbi, functionName: "executeBuy",
    args: [marketId, 0, BUY_AMOUNT, 0n],
  }));
  const yesShares = (await publicClient.readContract({
    address: marketsAddr, abi: marketsAbi, functionName: "yesBalance", args: [marketId, vault],
  })) as bigint;
  log.info("resolve-test: vault holds YES shares", {
    shares: (Number(yesShares) / 1e6).toFixed(4),
  });

  // 6. Wait until attestation is finalized + market is expired.
  const finalizeAt = Math.floor(Date.now() / 1000) + DISPUTE_WINDOW_SEC + 5;
  const waitSec = Math.max(0, finalizeAt - Math.floor(Date.now() / 1000));
  log.info("resolve-test: 6/8 waiting for finalize + expiry", { waitSec });
  await new Promise((r) => setTimeout(r, waitSec * 1000));

  // 7. Resolve.
  log.info("resolve-test: 7/8 resolve");
  const resolveHash = await walletClient.writeContract({
    address: marketsAddr, abi: marketsAbi, functionName: "resolve",
    args: [marketId],
  });
  await wait(resolveHash);
  const m = (await publicClient.readContract({
    address: marketsAddr, abi: marketsAbi, functionName: "getMarket", args: [marketId],
  })) as { phase: number; yesWon: boolean };
  log.info("resolve-test: resolved", { phase: m.phase, yesWon: m.yesWon });

  // 8. Vault redeems winnings.
  log.info("resolve-test: 8/8 vault.redeem");
  await wait(await walletClient.writeContract({
    address: vault, abi: vaultAbi, functionName: "redeem", args: [marketId],
  }));
  const navAfter = (await publicClient.readContract({
    address: vault, abi: vaultAbi, functionName: "nav",
  })) as bigint;
  const pnl = Number(navAfter - navBefore) / 1e6;
  log.info("resolve-test: DONE", {
    navBefore: (Number(navBefore) / 1e6).toFixed(4),
    navAfter: (Number(navAfter) / 1e6).toFixed(4),
    pnl: pnl.toFixed(4),
    pnlPositive: pnl > 0,
  });
  if (pnl <= 0) {
    log.error("resolve-test: pnl not positive after winning trade");
    process.exit(1);
  }
}

main().catch((e) => {
  log.error("resolve-test: crashed", { error: (e as Error).message });
  process.exit(1);
});
