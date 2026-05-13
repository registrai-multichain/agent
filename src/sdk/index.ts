// Public surface of the Registrai agent SDK.
// Eventual home: npm package `@registrai/agent-sdk`. Lives in this repo for
// the hackathon — extraction to a published package is a follow-up.

export { defineAgent, Agent } from "./agent.js";
export type { AgentConfig, AgentRunResult, RuntimeContext } from "./agent.js";

export { median, trimByPercentile, hashRecords } from "./compute.js";

export { fetchText, fetchJson, sleep } from "./http.js";
export type { FetchOptions } from "./http.js";

export { preflight, submitAttestation, registryAbi, attestationAbi } from "./chain.js";
export type { ChainContext, AttestArgs } from "./chain.js";

export { log } from "./logger.js";
