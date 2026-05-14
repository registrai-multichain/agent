/**
 * Node daemon entry. Runs the Warsaw agent on a schedule. Use the Cloudflare
 * Worker entry (`worker.ts`) for production hosting — this is the local /
 * VPS-style runner.
 */
import { config as loadEnv } from "dotenv";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { buildWarsawAgent } from "./agents/warsaw.js";
import { log } from "@registrai/agent-sdk";

loadEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const DEFAULT_OTODOM_URL =
  "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/mazowieckie/warszawa/warszawa/warszawa";
const ATTEST_HOUR_UTC = 14;

interface ParsedConfig {
  dryRun: boolean;
  runOnce: boolean;
  rpcUrl: string;
  privateKey: Hex;
  feedId: Hex;
  registryAddress: Address;
  attestationAddress: Address;
  methodologyCid: string;
  otodomUrl: string;
  nbpReportUrl: string;
}

function loadConfig(argv: readonly string[]): ParsedConfig {
  const dryRun = argv.includes("--dry-run");
  const runOnce = argv.includes("--once");

  const privateKey = (dryRun
    ? "0x0000000000000000000000000000000000000000000000000000000000000001"
    : required("PRIVATE_KEY")) as Hex;
  if (!isHex(privateKey, { strict: true })) throw new Error("PRIVATE_KEY must be 0x hex");

  const registryAddress = (dryRun
    ? "0x0000000000000000000000000000000000000000"
    : required("REGISTRY_ADDRESS")) as Address;
  const attestationAddress = (dryRun
    ? "0x0000000000000000000000000000000000000000"
    : required("ATTESTATION_ADDRESS")) as Address;
  if (!dryRun) {
    if (!isAddress(registryAddress)) throw new Error("REGISTRY_ADDRESS invalid");
    if (!isAddress(attestationAddress)) throw new Error("ATTESTATION_ADDRESS invalid");
  }

  const feedId = (dryRun ? `0x${"00".repeat(32)}` : required("FEED_ID")) as Hex;
  if (!isHex(feedId) || feedId.length !== 66) throw new Error("FEED_ID must be 32-byte hex");

  return {
    dryRun,
    runOnce,
    rpcUrl: dryRun ? optional("RPC_URL", "http://localhost:8545") : required("RPC_URL"),
    privateKey,
    feedId,
    registryAddress,
    attestationAddress,
    methodologyCid: optional("METHODOLOGY_CID", "ipfs://warsaw-resi-v1-placeholder"),
    otodomUrl: optional("OTODOM_URL", DEFAULT_OTODOM_URL),
    nbpReportUrl: process.env.NBP_REPORT_URL ?? "",
  };
}

async function runOnce(cfg: ParsedConfig): Promise<void> {
  const agent = buildWarsawAgent({
    feedId: cfg.feedId,
    registryAddress: cfg.registryAddress,
    attestationAddress: cfg.attestationAddress,
    methodologyCid: cfg.methodologyCid,
    otodomUrl: cfg.otodomUrl,
    nbpReportUrl: cfg.nbpReportUrl,
  });

  if (cfg.dryRun) {
    await agent.dryRun();
    return;
  }

  await agent.attest({ privateKey: cfg.privateKey, rpcUrl: cfg.rpcUrl });
}

function msUntilNext(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.argv.slice(2));
  log.info("run: starting", { dryRun: cfg.dryRun, runOnce: cfg.runOnce, feedId: cfg.feedId });

  if (cfg.runOnce || cfg.dryRun) {
    await runOnce(cfg);
    return;
  }

  while (true) {
    const wait = msUntilNext(ATTEST_HOUR_UTC);
    log.info("scheduler: sleeping until next run", {
      wakeAt: new Date(Date.now() + wait).toISOString(),
    });
    await new Promise((r) => setTimeout(r, wait));
    try {
      await runOnce(cfg);
    } catch (e) {
      log.error("run: failed", { error: (e as Error).message });
    }
  }
}

main().catch((e) => {
  log.error("fatal", { error: (e as Error).message });
  process.exit(1);
});
