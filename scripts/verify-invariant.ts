/**
 * Proves the verifiable-agents invariant end to end against live Arc state.
 *
 *   1. Pull the Attested event for the verifiable Warsaw feed
 *   2. Fetch the originating tx, decode (feedId, rawInputs)
 *   3. Recompute inputHash = keccak256(abi.encode(rawInputs))
 *      → must equal the inputHash stored in the event
 *   4. Call MedianRule.submit(rawInputs) via eth_call
 *      → must equal the value stored in the attestation
 *
 * If both equalities hold, the chain proves: agent submitted exactly
 * these inputs, the rule contract computed exactly this median.
 * Aggregation math = bytecode anyone can read.
 */
import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  http,
  keccak256,
  type Hex,
} from "viem";
import deployment from "../../contracts/deployments/arc-testnet.json" with { type: "json" };

const ATT_V11 = "0xf0caf69125bd17717c4804edce61bbdacd52ac60";
const MEDIAN_RULE = "0x415fb74629d8eab51b7991679cec6cb71f3fb997";
const FEED_ID = "0x89453b87d3965a0f8132a29414ad3ed0b1950ee743cfcf6d85cfea8038d8ac5a";
const AGENT = "0x84C799941C6B69AbB296EC46a02E4e0772Ad2E5e";
const KNOWN_TX = "0xce87ee21b461cf40f452d6a0cce63ebaca04c87d2558ed6367a7ee83cbb487b4";

const attestWithRuleAbi = [{
  type: "function", name: "attestWithRule", stateMutability: "nonpayable",
  inputs: [
    { name: "feedId", type: "bytes32" },
    { name: "rawInputs", type: "int256[]" },
  ],
  outputs: [{ name: "attestationId", type: "bytes32" }],
}] as const;

const medianRuleAbi = [{
  type: "function", name: "submit", stateMutability: "view",
  inputs: [{ name: "raw", type: "int256[]" }],
  outputs: [{ name: "value", type: "int256" }],
}] as const;

const attestationAbi = [{
  type: "function", name: "latestValue", stateMutability: "view",
  inputs: [{ name: "feedId", type: "bytes32" }, { name: "agent", type: "address" }],
  outputs: [
    { name: "value", type: "int256" },
    { name: "timestamp", type: "uint256" },
    { name: "finalized", type: "bool" },
  ],
}] as const;

function fmt(b: boolean) { return b ? "✓ PASS" : "✗ FAIL"; }

async function main() {
  const rpcUrl = process.env.RPC ?? deployment.rpc;
  const client = createPublicClient({ transport: http(rpcUrl) });

  console.log("=".repeat(64));
  console.log("Verifiable agents · live invariant check");
  console.log("=".repeat(64));

  // 1. Fetch the tx calldata
  const tx = await client.getTransaction({ hash: KNOWN_TX as Hex });
  console.log(`\n[1] tx fetched · block ${tx.blockNumber} · from ${tx.from}`);
  console.log(`    to = ${tx.to}`);
  const toOk = tx.to?.toLowerCase() === ATT_V11.toLowerCase();
  console.log(`    targets Attestation v1.1: ${fmt(toOk)}`);

  // 2. Decode calldata → (feedId, rawInputs[])
  const decoded = decodeFunctionData({ abi: attestWithRuleAbi, data: tx.input });
  if (decoded.functionName !== "attestWithRule") throw new Error("wrong function");
  const [decFeed, decRaw] = decoded.args;
  const rawInputs = decRaw as readonly bigint[];
  console.log(`\n[2] decoded calldata`);
  console.log(`    feedId  = ${decFeed}`);
  console.log(`    inputs  = [${rawInputs.length}] first 3 = ${rawInputs.slice(0, 3).join(", ")}…`);
  const feedOk = (decFeed as string).toLowerCase() === FEED_ID.toLowerCase();
  console.log(`    matches expected feedId: ${fmt(feedOk)}`);

  // 3. Recompute inputHash and verify against the on-chain Attested event
  const computedHash = keccak256(
    encodeAbiParameters([{ type: "int256[]" }], [Array.from(rawInputs)]),
  );
  console.log(`\n[3] inputHash recomputation`);
  console.log(`    keccak256(abi.encode(rawInputs)) = ${computedHash}`);
  const events = await client.getLogs({
    address: ATT_V11 as Hex,
    event: {
      type: "event", name: "Attested", anonymous: false,
      inputs: [
        { name: "attestationId", type: "bytes32", indexed: true },
        { name: "feedId", type: "bytes32", indexed: true },
        { name: "agent", type: "address", indexed: true },
        { name: "value", type: "int256", indexed: false },
        { name: "inputHash", type: "bytes32", indexed: false },
        { name: "finalizedAt", type: "uint256", indexed: false },
      ],
    },
    fromBlock: tx.blockNumber!,
    toBlock: tx.blockNumber!,
  });
  const ev = events.find((e) => e.transactionHash?.toLowerCase() === KNOWN_TX.toLowerCase());
  if (!ev) throw new Error("Attested event not found for tx");
  const onchainInputHash = ev.args.inputHash as Hex;
  const onchainValue = ev.args.value as bigint;
  console.log(`    inputHash on chain               = ${onchainInputHash}`);
  const hashOk = computedHash.toLowerCase() === onchainInputHash.toLowerCase();
  console.log(`    hashes match: ${fmt(hashOk)}`);

  // 4. Call MedianRule.submit(rawInputs) — must return the on-chain value
  const computedMedian = await client.readContract({
    address: MEDIAN_RULE as Hex,
    abi: medianRuleAbi,
    functionName: "submit",
    args: [Array.from(rawInputs)],
  }) as bigint;
  console.log(`\n[4] independent recomputation via MedianRule.submit`);
  console.log(`    MedianRule.submit(rawInputs) = ${computedMedian}`);
  console.log(`    on-chain attested value      = ${onchainValue}`);
  const valueOk = computedMedian === onchainValue;
  console.log(`    values match: ${fmt(valueOk)}`);

  // 5. Cross-check via latestValue()
  const [latestValue] = await client.readContract({
    address: ATT_V11 as Hex,
    abi: attestationAbi,
    functionName: "latestValue",
    args: [FEED_ID as Hex, AGENT as Hex],
  }) as readonly [bigint, bigint, boolean];
  console.log(`\n[5] latestValue() sanity = ${latestValue}`);
  const sanityOk = latestValue === computedMedian;
  console.log(`    matches recomputation: ${fmt(sanityOk)}`);

  console.log("\n" + "=".repeat(64));
  const allOk = toOk && feedOk && hashOk && valueOk && sanityOk;
  console.log(`Invariant proof: ${allOk ? "✓ HOLDS" : "✗ BROKEN"}`);
  console.log("=".repeat(64));
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
