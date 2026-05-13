/**
 * Chain-side helpers. viem only — works in Node, Cloudflare Workers, browsers.
 * Provides preflight (active + bond + methodology) and attestation submission
 * with simulation and receipt waiting.
 */
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { log } from "./logger.js";

export const registryAbi = [
  {
    type: "function",
    name: "getAgent",
    stateMutability: "view",
    inputs: [
      { name: "feedId", type: "bytes32" },
      { name: "agent", type: "address" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "agentMethodologyHash", type: "bytes32" },
          { name: "bond", type: "uint256" },
          { name: "lockedBond", type: "uint256" },
          { name: "registeredAt", type: "uint256" },
          { name: "lastAttestationAt", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "slashed", type: "bool" },
        ],
      },
    ],
  },
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

export const attestationAbi = [
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "feedId", type: "bytes32" },
      { name: "value", type: "int256" },
      { name: "inputHash", type: "bytes32" },
    ],
    outputs: [{ name: "attestationId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "latestValue",
    stateMutability: "view",
    inputs: [
      { name: "feedId", type: "bytes32" },
      { name: "agent", type: "address" },
    ],
    outputs: [
      { name: "value", type: "int256" },
      { name: "timestamp", type: "uint256" },
      { name: "finalized", type: "bool" },
    ],
  },
] as const;

export interface ChainContext {
  rpcUrl: string;
  privateKey: Hex;
  registryAddress: Address;
  attestationAddress: Address;
  feedId: Hex;
  /** The IPFS CID the agent committed to at registration. */
  methodologyCid: string;
  chainId?: number;
}

export interface AttestArgs {
  value: bigint | number;
  inputHash: Hex;
}

function client(ctx: ChainContext) {
  const chain = ctx.chainId
    ? defineChain({
        id: ctx.chainId,
        name: `chain-${ctx.chainId}`,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [ctx.rpcUrl] } },
      })
    : undefined;
  return {
    publicClient: createPublicClient({ chain, transport: http(ctx.rpcUrl) }),
    account: privateKeyToAccount(ctx.privateKey),
  };
}

/**
 * Preflight check before each attestation: agent must be active, not slashed,
 * have available bond ≥ feed.minBond, and the onchain methodology hash must
 * match what this agent thinks it's committed to.
 */
export async function preflight(ctx: ChainContext): Promise<void> {
  const { publicClient, account } = client(ctx);

  const agentInfo = (await publicClient.readContract({
    address: ctx.registryAddress,
    abi: registryAbi,
    functionName: "getAgent",
    args: [ctx.feedId, account.address],
  })) as {
    agentMethodologyHash: Hex;
    bond: bigint;
    lockedBond: bigint;
    active: boolean;
    slashed: boolean;
  };

  if (agentInfo.slashed) throw new Error("preflight: agent has been slashed");
  if (!agentInfo.active) throw new Error("preflight: agent inactive");

  const feed = (await publicClient.readContract({
    address: ctx.registryAddress,
    abi: registryAbi,
    functionName: "getFeed",
    args: [ctx.feedId],
  })) as { minBond: bigint };

  const available = agentInfo.bond - agentInfo.lockedBond;
  if (available < feed.minBond) {
    throw new Error(
      `preflight: insufficient available bond (have ${available}, need ${feed.minBond})`,
    );
  }

  const expectedHash = keccak256(toHex(ctx.methodologyCid));
  if (agentInfo.agentMethodologyHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `preflight: methodology hash mismatch (onchain=${agentInfo.agentMethodologyHash}, expected=${expectedHash})`,
    );
  }

  log.info("preflight: ok", {
    agent: account.address,
    bond: agentInfo.bond.toString(),
    lockedBond: agentInfo.lockedBond.toString(),
  });
}

export async function submitAttestation(ctx: ChainContext, args: AttestArgs): Promise<Hex> {
  const { publicClient, account } = client(ctx);
  const walletClient = createWalletClient({ account, transport: http(ctx.rpcUrl) });

  const { request } = await publicClient.simulateContract({
    account,
    address: ctx.attestationAddress,
    abi: attestationAbi,
    functionName: "attest",
    args: [ctx.feedId, BigInt(args.value), args.inputHash],
  });

  const hash = await walletClient.writeContract(request);
  log.info("attest: tx submitted", { hash, value: args.value.toString() });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`attest: tx reverted (${hash})`);
  }
  log.info("attest: tx confirmed", { hash, block: receipt.blockNumber.toString() });
  return hash;
}
