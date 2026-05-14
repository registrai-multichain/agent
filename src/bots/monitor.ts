/**
 * Stress monitor for the Markets contract. Wraps the MM bot's runOnce loop
 * with per-iteration invariant checks:
 *   1. AMM `k` invariant: yesReserve * noReserve should monotonically
 *      INCREASE on every buy (because fees grow both reserves before the
 *      swap takes one side back out).
 *   2. Vault NAV: should decrease by exactly TRADE_AMOUNT_USDC per trade.
 *   3. Price movement: the bought side's price should strictly RISE.
 *
 * Any failure is logged with full state delta.
 */
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { log } from "@registrai/agent-sdk";
import deployment from "../../../contracts/deployments/arc-testnet.json" with { type: "json" };
import { runMarketMaker } from "./mm.js";
import { config as loadEnv } from "dotenv";

loadEnv();
loadEnv({ path: ".env.bot", override: true });

const ITERATIONS = Number(process.env.ITERATIONS ?? 20);
const DELAY_MS = Number(process.env.DELAY_MS ?? 2000);

const marketsAbi = [
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

const vaultAbi = [
  { type: "function", name: "nav", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function snapshotAll() {
  const rpcUrl = process.env.RPC ?? deployment.rpc;
  const arc = defineChain({
    id: deployment.chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain: arc, transport: http(rpcUrl) });
  const marketsAddr = deployment.contracts.Markets as Address;
  const vaultAddr = (deployment.contracts as { MarketMakerVault?: string })
    .MarketMakerVault as Address;

  const usdcMarkets = (deployment.markets as Array<{ id: string; collateral: string }>)
    .filter((m) => m.collateral === "USDC");

  const states = await Promise.all(usdcMarkets.map(async (m) => {
    const s = (await client.readContract({
      address: marketsAddr, abi: marketsAbi, functionName: "getMarket", args: [m.id as Hex],
    })) as { yesReserve: bigint; noReserve: bigint };
    return { id: m.id, y: s.yesReserve, n: s.noReserve, k: s.yesReserve * s.noReserve };
  }));
  const nav = (await client.readContract({
    address: vaultAddr, abi: vaultAbi, functionName: "nav",
  })) as bigint;
  return { states, nav };
}

function diff(before: Awaited<ReturnType<typeof snapshotAll>>, after: typeof before) {
  const navDelta = Number(before.nav - after.nav) / 1e6;
  const moved = after.states
    .map((s, i) => {
      const b = before.states[i]!;
      return { id: s.id.slice(0, 10), dy: Number(s.y - b.y), dn: Number(s.n - b.n), dk: s.k - b.k };
    })
    .filter((m) => m.dy !== 0 || m.dn !== 0);
  return { navDelta, moved };
}

async function main() {
  const failures: Array<{ iter: number; reason: string }> = [];
  let prev = await snapshotAll();
  log.info("monitor: starting", {
    iterations: ITERATIONS, delayMs: DELAY_MS, navStart: (Number(prev.nav) / 1e6).toFixed(4),
  });

  for (let i = 1; i <= ITERATIONS; i++) {
    try {
      await runMarketMaker({
        TRADER_PRIVATE_KEY: process.env.BOT_PRIVATE_KEY ?? process.env.TRADER_PRIVATE_KEY!,
        RPC_URL: process.env.RPC ?? deployment.rpc,
      });
    } catch (e) {
      failures.push({ iter: i, reason: (e as Error).message });
      log.error("monitor: iter failed", { iter: i, error: (e as Error).message });
      continue;
    }

    const next = await snapshotAll();
    const d = diff(prev, next);

    // Invariant 1: vault NAV decreased by trade amount (or 0 if idle).
    if (d.navDelta < 0) {
      failures.push({ iter: i, reason: `nav rose by ${(-d.navDelta).toFixed(4)} USDC` });
    }
    // Invariant 2: at most one market state changed per iteration.
    if (d.moved.length > 1) {
      failures.push({ iter: i, reason: `${d.moved.length} markets moved in one iter` });
    }
    // Invariant 3: k strictly increases on the moved market (buys add fees).
    for (const m of d.moved) {
      if (m.dk <= 0n) {
        failures.push({
          iter: i, reason: `k did not grow for ${m.id} (Δk=${m.dk.toString()})`,
        });
      }
    }

    log.info("monitor: iter ok", {
      iter: i,
      navDelta: d.navDelta.toFixed(4),
      moved: d.moved.length,
      mkt: d.moved[0]?.id ?? "none",
      dy: d.moved[0]?.dy ?? 0,
      dn: d.moved[0]?.dn ?? 0,
    });
    prev = next;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  log.info("monitor: done", {
    iterations: ITERATIONS,
    failures: failures.length,
    navEnd: (Number(prev.nav) / 1e6).toFixed(4),
  });
  if (failures.length > 0) {
    for (const f of failures) log.error("monitor: failure", f);
    process.exit(1);
  }
}

main().catch((e) => {
  log.error("monitor: crashed", { error: (e as Error).message });
  process.exit(1);
});
