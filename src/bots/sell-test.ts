/**
 * Sell-side stress test. Reads every USDC market, looks up the vault's
 * yes/no balances, picks the largest non-zero position, and sells half of
 * it through the vault. Verifies post-state invariants: AMM `k` strictly
 * GREW (because half the sold shares are burned in complete-set unwinding,
 * boosting reserves on the unsold side), vault NAV strictly INCREASED.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { log } from "@registrai/agent-sdk";
import { config as loadEnv } from "dotenv";
import deployment from "../../../contracts/deployments/arc-testnet.json" with { type: "json" };

loadEnv();
loadEnv({ path: ".env.bot", override: true });

const ITERATIONS = Number(process.env.ITERATIONS ?? 5);

const vaultAbi = [
  { type: "function", name: "executeSell", stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "sharesIn", type: "uint256" },
      { name: "minCollateralOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "nav", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const marketsAbi = [
  { type: "function", name: "yesBalance", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "user", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "noBalance", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "user", type: "address" }],
    outputs: [{ type: "uint256" }] },
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

  const marketsAddr = deployment.contracts.Markets as Address;
  const vaultAddr = (deployment.contracts as { MarketMakerVault?: string })
    .MarketMakerVault as Address;
  const usdcMarkets = (deployment.markets as Array<{ id: string; collateral: string }>)
    .filter((m) => m.collateral === "USDC");

  let failures = 0;
  for (let i = 1; i <= ITERATIONS; i++) {
    // Snapshot vault NAV and all positions.
    const navBefore = (await publicClient.readContract({
      address: vaultAddr, abi: vaultAbi, functionName: "nav",
    })) as bigint;

    const positions = await Promise.all(usdcMarkets.map(async (m) => {
      const [yes, no, market] = await Promise.all([
        publicClient.readContract({
          address: marketsAddr, abi: marketsAbi, functionName: "yesBalance",
          args: [m.id as Hex, vaultAddr],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: marketsAddr, abi: marketsAbi, functionName: "noBalance",
          args: [m.id as Hex, vaultAddr],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: marketsAddr, abi: marketsAbi, functionName: "getMarket",
          args: [m.id as Hex],
        }) as Promise<{ yesReserve: bigint; noReserve: bigint }>,
      ]);
      return { id: m.id as Hex, yes, no, market };
    }));

    // Pick the largest single position.
    const flat = positions.flatMap((p) => [
      { id: p.id, outcome: 0, shares: p.yes, market: p.market },
      { id: p.id, outcome: 1, shares: p.no, market: p.market },
    ]).filter((p) => p.shares > 0n);

    if (flat.length === 0) {
      log.info("sell-test: no positions to sell, exiting", { iter: i });
      break;
    }
    flat.sort((a, b) => (b.shares > a.shares ? 1 : -1));
    const target = flat[0]!;
    const sharesIn = target.shares / 2n; // sell half
    const kBefore = target.market.yesReserve * target.market.noReserve;

    log.info("sell-test: selling", {
      iter: i,
      market: target.id.slice(0, 10),
      side: target.outcome === 0 ? "YES" : "NO",
      sharesIn: (Number(sharesIn) / 1e6).toFixed(6),
      navBefore: (Number(navBefore) / 1e6).toFixed(4),
    });

    const hash = await walletClient.writeContract({
      address: vaultAddr, abi: vaultAbi, functionName: "executeSell",
      args: [target.id, target.outcome, sharesIn, 0n],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      log.error("sell-test: revert", { iter: i, tx: hash });
      failures++;
      continue;
    }

    const navAfter = (await publicClient.readContract({
      address: vaultAddr, abi: vaultAbi, functionName: "nav",
    })) as bigint;
    const marketAfter = (await publicClient.readContract({
      address: marketsAddr, abi: marketsAbi, functionName: "getMarket",
      args: [target.id],
    })) as { yesReserve: bigint; noReserve: bigint };
    const kAfter = marketAfter.yesReserve * marketAfter.noReserve;

    const navDelta = Number(navAfter - navBefore) / 1e6;
    log.info("sell-test: result", {
      iter: i, tx: hash, navDelta: navDelta.toFixed(6),
      kBefore: kBefore.toString(), kAfter: kAfter.toString(),
      kGrew: kAfter > kBefore,
    });

    // Invariants: nav strictly rose, k strictly rose.
    if (navAfter <= navBefore) {
      log.error("sell-test: nav did not grow", { iter: i });
      failures++;
    }
    if (kAfter <= kBefore) {
      log.error("sell-test: k did not grow", { iter: i });
      failures++;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log.info("sell-test: done", { failures });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { log.error("sell-test: crashed", { error: (e as Error).message }); process.exit(1); });
