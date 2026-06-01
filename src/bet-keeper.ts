/**
 * Force-close keeper for the CirqueBetLending product (borrow USDC against a
 * prediction-market position you hold).
 *
 * ⚠️ The contract is NOT yet deployed. This keeper is dormant until
 * BET_LENDING_ADDR + BET_KEEPER_PRIVATE_KEY are configured; the worker skips
 * it otherwise. It is committed now so the liveness story ships with the
 * contract, not after.
 *
 * WHY A KEEPER (security finding #2, belt-and-suspenders):
 * CirqueBetLending makes force-close PERMISSIONLESS and INCENTIVISED — the
 * liquidator of an in-the-money position keeps a 5% bonus, so a profit-seeking
 * actor will normally close loans before expiry on their own. The keeper does
 * not replace that incentive; it guarantees liveness for the two cases a
 * profit-seeker won't touch:
 *
 *   1. WRITE-OFF (free): a loan whose market resolved and whose side LOST. The
 *      collateral is worth $0, so no liquidator will pay `owed` for it, yet its
 *      principal keeps counting as pool value (phantom value → withdraw race).
 *      `writeOffBadDebt` is permissionless and costs only gas — the keeper
 *      calls it the instant the loss exists, socializing it pro-rata and
 *      closing the race. This is always safe to do.
 *
 *   2. FORCE-CLOSE (profitable only): a loan inside the 2h pre-expiry window
 *      that no one has closed. The keeper liquidates it ONLY when the
 *      collateral is worth at least `owed` (so paying `owed` to seize shares
 *      worth ≥ owed is break-even-or-better). It NEVER liquidates an
 *      underwater-but-unresolved position at a loss — that case resolves into
 *      either a profitable liquidation (side wins) or a free write-off (side
 *      loses), both handled above.
 *
 * Loan discovery: the contract has no on-chain enumeration (loans is a
 * mapping), so the keeper reconstructs the active-borrower set from BetBorrowed
 * logs minus those since closed, then re-reads each loan's live state on chain
 * (logs are only a hint; every action is gated on a fresh `loans()` read).
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

/// Mirrors CirqueBetLending.FORCE_CLOSE_WINDOW (2 hours). Inside this window
/// before a market's expiry, any loan is force-liquidatable regardless of
/// health — the cliff guard, so no loan survives into resolution.
const FORCE_CLOSE_WINDOW = 2n * 60n * 60n; // seconds

/// Mirrors CirqueBetLending.LIQ_LTV_BPS (60%). Above this, a loan is
/// liquidatable on health alone (outside the force window).
const LIQ_LTV_BPS = 6000n;

/// Market phase enum (Markets.Phase): 0=Trading, 1=Resolved (+ others).
const PHASE_RESOLVED = 1;

interface BetKeeperEnv {
  RPC_URL: string;
  /** Private key of the keeper wallet. Needs USDC + native gas to fund the
   *  `owed` repayment on profitable force-closes; write-offs cost only gas. */
  BET_KEEPER_PRIVATE_KEY: string;
  /** CirqueBetLending address (the borrow-against-bet pool). */
  BET_LENDING_ADDR: string;
  /** MarketsV3 address (to read market expiry/phase for each loan). */
  MARKETS_V3_ADDR: string;
  /** USDC ERC-20 (6-dp) used by the pool. */
  USDC_ADDR: string;
  /** Block to start scanning BetBorrowed logs from (contract deploy block).
   *  Defaults to 0 if unset. */
  BET_LENDING_DEPLOY_BLOCK?: string;
}

const lendingAbi = parseAbi([
  "function loans(address) view returns (bytes32 marketId, bool betYes, uint256 shares, uint256 principal, uint256 borrowedAt, bool active, uint256 markValueAtBorrow)",
  "function isWriteOffable(address) view returns (bool)",
  "function healthBps(address) view returns (uint256)",
  "function collateralValueUSDC(address) view returns (uint256)",
  "function interestOwed(address) view returns (uint256)",
  "function liquidateBet(address borrower)",
  "function writeOffBadDebt(address borrower)",
  "event BetBorrowed(address indexed user, bytes32 indexed marketId, bool betYes, uint256 collateralShares, uint256 principal)",
]);

const marketsAbi = parseAbi([
  "function getMarket(bytes32) view returns (tuple(bytes32 feedId, address agent, int256 threshold, uint8 comparator, uint256 expiry, address creator, uint256 yesReserve, uint256 noReserve, uint8 phase, bool yesWon, uint256 createdAt))",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["placeholder"] } },
});

// ──────────────────────────── Entry point ─────────────────────────────

export async function runBetKeeper(env: BetKeeperEnv): Promise<void> {
  const chain = { ...arcTestnet, rpcUrls: { default: { http: [env.RPC_URL] } } };
  const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL) });
  const account = privateKeyToAccount(env.BET_KEEPER_PRIVATE_KEY as Hex);
  const walletClient = createWalletClient({ chain, transport: http(env.RPC_URL), account });

  const lending = env.BET_LENDING_ADDR as Address;
  const marketsV3 = env.MARKETS_V3_ADDR as Address;
  const usdc = env.USDC_ADDR as Address;

  // ─── 1. Discover candidate borrowers from BetBorrowed logs ───
  const fromBlock = env.BET_LENDING_DEPLOY_BLOCK
    ? BigInt(env.BET_LENDING_DEPLOY_BLOCK)
    : 0n;
  let borrowers: Address[];
  try {
    const logs = await publicClient.getLogs({
      address: lending,
      event: lendingAbi[7], // BetBorrowed
      fromBlock,
      toBlock: "latest",
    });
    borrowers = [...new Set(logs.map((l) => (l.args as { user: Address }).user))];
  } catch (e) {
    console.error(`bet-keeper: log scan failed: ${(e as Error).message}`);
    return;
  }
  if (borrowers.length === 0) {
    console.log("bet-keeper: no borrowers seen, nothing to do");
    return;
  }
  console.log(`bet-keeper: ${borrowers.length} candidate borrower(s)`);

  const now = BigInt(Math.floor(await currentChainTime(publicClient)));

  // ─── 2. Act on each loan from a FRESH on-chain read ───
  for (const borrower of borrowers) {
    try {
      await processLoan({
        publicClient, walletClient, account,
        lending, marketsV3, usdc, borrower, now,
      });
    } catch (e) {
      console.error(`bet-keeper: ${borrower} failed: ${(e as Error).message}`);
    }
  }
}

async function processLoan(args: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  lending: Address;
  marketsV3: Address;
  usdc: Address;
  borrower: Address;
  now: bigint;
}): Promise<void> {
  const { publicClient, walletClient, account, lending, marketsV3, usdc, borrower, now } = args;

  const loan = (await publicClient.readContract({
    address: lending, abi: lendingAbi, functionName: "loans", args: [borrower],
  })) as [Hex, boolean, bigint, bigint, bigint, boolean, bigint];
  const active = loan[5];
  if (!active) return; // already closed — log was stale

  const marketId = loan[0];
  const principal = loan[3];

  // ─── 2a. Free write-off of an unrecoverable (resolved-loser) loan ───
  const writeOffable = (await publicClient.readContract({
    address: lending, abi: lendingAbi, functionName: "isWriteOffable", args: [borrower],
  })) as boolean;
  if (writeOffable) {
    const hash = await walletClient.writeContract({
      address: lending, abi: lendingAbi, functionName: "writeOffBadDebt",
      args: [borrower], account, chain: walletClient.chain, gas: 300_000n,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`bet-keeper: writeOffBadDebt(${borrower}) ${r.status} tx=${hash}`);
    return;
  }

  // ─── 2b. Force-close / health liquidation (only when not at a loss) ───
  const market = (await publicClient.readContract({
    address: marketsV3, abi: marketsAbi, functionName: "getMarket", args: [marketId],
  })) as { expiry: bigint; phase: number };

  const health = (await publicClient.readContract({
    address: lending, abi: lendingAbi, functionName: "healthBps", args: [borrower],
  })) as bigint;

  const inForceWindow =
    market.phase !== PHASE_RESOLVED && now + FORCE_CLOSE_WINDOW >= market.expiry;
  const unhealthy = health > LIQ_LTV_BPS;
  if (!inForceWindow && !unhealthy) return; // healthy and not near expiry — leave it

  // Only liquidate when the collateral covers `owed` — otherwise the keeper
  // would pay more than it receives. Underwater-but-unresolved loans are left
  // for resolution (→ profitable liquidation if the side wins, or a free
  // write-off if it loses). This keeps the keeper economically self-funding.
  const interest = (await publicClient.readContract({
    address: lending, abi: lendingAbi, functionName: "interestOwed", args: [borrower],
  })) as bigint;
  const owed = principal + interest;
  const collateralValue = (await publicClient.readContract({
    address: lending, abi: lendingAbi, functionName: "collateralValueUSDC", args: [borrower],
  })) as bigint;

  if (collateralValue < owed) {
    console.log(
      `bet-keeper: ${borrower} liquidatable but underwater (collateral=${collateralValue} < owed=${owed}) — deferring to resolution`,
    );
    return;
  }

  // Ensure the keeper can pay `owed`: balance + allowance.
  const bal = (await publicClient.readContract({
    address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;
  if (bal < owed) {
    console.error(`bet-keeper: ${borrower} skip — keeper USDC ${bal} < owed ${owed}`);
    return;
  }
  const allowance = (await publicClient.readContract({
    address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, lending],
  })) as bigint;
  if (allowance < owed) {
    const ah = await walletClient.writeContract({
      address: usdc, abi: erc20Abi, functionName: "approve",
      args: [lending, owed * 2n], account, chain: walletClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: ah });
  }

  const hash = await walletClient.writeContract({
    address: lending, abi: lendingAbi, functionName: "liquidateBet",
    args: [borrower], account, chain: walletClient.chain, gas: 600_000n,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  console.log(
    `bet-keeper: liquidateBet(${borrower}) ${r.status} tx=${hash} (force=${inForceWindow} health=${health}bps)`,
  );
}

async function currentChainTime(
  publicClient: ReturnType<typeof createPublicClient>,
): Promise<number> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}
