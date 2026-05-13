/**
 * The `defineAgent` primitive. Authors describe what their agent fetches and
 * computes; the SDK handles preflight, attestation submission, and runtime
 * wiring. The same agent definition works under any host (Node daemon,
 * Cloudflare Worker, Phala CVM, etc.) — the host just calls `agent.attest()`
 * on its own schedule.
 */
import type { Address, Hex } from "viem";
import { preflight, submitAttestation, type ChainContext } from "./chain.js";
import { log } from "./logger.js";

export interface AgentRunResult {
  /** Signed 256-bit integer value to attest. */
  value: bigint | number;
  /** Deterministic hash of the inputs used. */
  inputHash: Hex;
  /** Free-form context for logs (not committed onchain). */
  context?: Record<string, unknown>;
}

export interface AgentConfig {
  /** Human-readable identifier, e.g. "warsaw-resi". */
  name: string;
  /** Cron schedule (used by runtime adapters that respect it). */
  schedule: string;
  /** The feed this agent attests to. */
  feedId: Hex;
  /** Registry contract address. */
  registryAddress: Address;
  /** Attestation contract address. */
  attestationAddress: Address;
  /** Methodology CID (canonical reference). */
  methodologyCid: string;
  /** Author's compute function. Fetches + computes + returns value + inputHash. */
  run: () => Promise<AgentRunResult>;
}

export interface RuntimeContext {
  /** Private key for signing. */
  privateKey: Hex;
  /** RPC endpoint URL. */
  rpcUrl: string;
  /** Optional chain id override (defaults to whatever the RPC reports). */
  chainId?: number;
}

export class Agent {
  constructor(public readonly config: AgentConfig) {}

  /** Runs the agent's compute function and returns the result without attesting. */
  async dryRun(): Promise<AgentRunResult> {
    log.info("agent: dry run starting", { name: this.config.name });
    const result = await this.config.run();
    log.info("agent: dry run result", {
      name: this.config.name,
      value: result.value.toString(),
      inputHash: result.inputHash,
      ...result.context,
    });
    return result;
  }

  /** Full attest: preflight + run + submit. */
  async attest(runtime: RuntimeContext): Promise<{ value: bigint | number; inputHash: Hex; txHash: Hex }> {
    const chainCtx: ChainContext = {
      rpcUrl: runtime.rpcUrl,
      privateKey: runtime.privateKey,
      registryAddress: this.config.registryAddress,
      attestationAddress: this.config.attestationAddress,
      feedId: this.config.feedId,
      methodologyCid: this.config.methodologyCid,
      chainId: runtime.chainId,
    };

    await preflight(chainCtx);
    const result = await this.config.run();
    log.info("agent: computed", {
      name: this.config.name,
      value: result.value.toString(),
      inputHash: result.inputHash,
      ...result.context,
    });

    const txHash = await submitAttestation(chainCtx, {
      value: result.value,
      inputHash: result.inputHash,
    });
    return { value: result.value, inputHash: result.inputHash, txHash };
  }
}

export function defineAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
