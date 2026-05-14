/**
 * LLM-powered market proposer. Every 6 hours, reads the latest attestation
 * for each registered feed and asks an LLM to propose new prediction
 * markets — threshold, comparator, expiry, and a short rationale per
 * proposal. Proposals are stored as JSON so the frontend can render them
 * under "agent-suggested markets" with one-click deploy.
 *
 * This is the "Agentic Sophistication" surface: a real autonomous
 * decision-making loop (read state → reason → propose action). The
 * deployment of any given proposal still requires a human creator to sign
 * — the agent doesn't have funds and can't sign for them.
 */
import { type Hex } from "viem";
import { log } from "@registrai/agent-sdk";

export interface AttestationSnapshot {
  feedSymbol: string;
  feedDescription: string;
  feedId: Hex;
  unit: string;
  currentValue: number;
  recentValues: number[];
  existingThresholds: number[];
}

export interface Proposal {
  threshold: number;
  comparator: ">" | ">=" | "<" | "<=";
  expiryDays: number;
  rationale: string;
}

export interface ProposalSet {
  generatedAt: string;
  feedId: Hex;
  feedSymbol: string;
  proposals: Proposal[];
  source: "claude" | "heuristic";
}

const SYSTEM_PROMPT = `You are an analyst for Registrai, a permissionless prediction-market protocol. Your job is to propose NEW binary prediction markets that would attract trading interest.

A binary market binds a numeric feed value at a future expiry against a threshold and a comparator. YES wins if the relation holds; NO wins if it does not.

Hard constraints:
- Threshold MUST be a plausible value the feed could realistically reach within the expiry window
- Threshold should NOT match an existing market's threshold (we want fresh markets)
- Expiry MUST be between 14 and 180 days
- Mix of "near-the-money" (close to current, ~50/50 odds), "moonshot" (tail upside), and "downside" (tail downside) markets
- Rationale must be 1-2 sentences citing an economic or domain reason

You MUST output ONLY valid JSON. No prose, no markdown fences, no preamble.`;

function userPrompt(snap: AttestationSnapshot): string {
  return `Feed: ${snap.feedSymbol}
Description: ${snap.feedDescription}
Unit: ${snap.unit}
Current value: ${snap.currentValue}
Recent values (oldest → newest): ${snap.recentValues.join(", ")}
Existing thresholds: ${snap.existingThresholds.join(", ") || "(none yet)"}

Propose exactly 3 new binary markets. Output:
{"proposals":[{"threshold":<int>,"comparator":">"|">="|"<"|"<=","expiryDays":<int 14-180>,"rationale":"<short>"}]}`;
}

export async function generateProposals(
  snap: AttestationSnapshot,
  opts: { anthropicApiKey?: string },
): Promise<ProposalSet> {
  if (opts.anthropicApiKey) {
    try {
      const proposals = await callClaude(snap, opts.anthropicApiKey);
      return {
        generatedAt: new Date().toISOString(),
        feedId: snap.feedId,
        feedSymbol: snap.feedSymbol,
        proposals,
        source: "claude",
      };
    } catch (e) {
      log.warn("proposer: claude failed, falling back to heuristic", {
        error: (e as Error).message,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    feedId: snap.feedId,
    feedSymbol: snap.feedSymbol,
    proposals: heuristicProposals(snap),
    source: "heuristic",
  };
}

async function callClaude(snap: AttestationSnapshot, apiKey: string): Promise<Proposal[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Pinned to a published Sonnet snapshot. Bump as new versions land.
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt(snap) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  // Extract the JSON object (the model sometimes still adds whitespace/markdown).
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("anthropic: no JSON in response");
  const parsed = JSON.parse(match[0]) as { proposals: Proposal[] };
  // Validate each proposal — drop anything malformed rather than propagating
  // bad data into the UI.
  const valid = (parsed.proposals ?? [])
    .filter((p): p is Proposal => {
      if (!p || typeof p !== "object") return false;
      if (typeof p.threshold !== "number" || !Number.isFinite(p.threshold)) return false;
      if (!(p.comparator in { ">": 1, ">=": 1, "<": 1, "<=": 1 })) return false;
      if (typeof p.expiryDays !== "number" || p.expiryDays < 14 || p.expiryDays > 180) return false;
      if (typeof p.rationale !== "string" || p.rationale.length === 0) return false;
      return true;
    })
    .slice(0, 3);
  if (valid.length === 0) throw new Error("anthropic: no valid proposals");
  return valid;
}

/**
 * Heuristic fallback when no LLM key is available. Picks a near-the-money
 * market, a +7% moonshot, and a -5% downside.
 */
function heuristicProposals(snap: AttestationSnapshot): Proposal[] {
  const v = snap.currentValue;
  const existing = new Set(snap.existingThresholds);

  function pickThreshold(target: number, step = 50): number {
    let t = Math.round(target / step) * step;
    while (existing.has(t)) t += step;
    return t;
  }

  return [
    {
      threshold: pickThreshold(v * 1.005),
      comparator: ">",
      expiryDays: 30,
      rationale: `Near-the-money market expiring in a month — odds should start close to 50/50 and react to each daily attestation.`,
    },
    {
      threshold: pickThreshold(v * 1.07),
      comparator: ">=",
      expiryDays: 120,
      rationale: `Quarterly moonshot: roughly 7% appreciation in 4 months would meaningfully outpace Polish CPI; attractive YES bet for momentum traders.`,
    },
    {
      threshold: pickThreshold(v * 0.95),
      comparator: "<",
      expiryDays: 60,
      rationale: `Downside hedge for owners or potential buyers — a 5% pullback inside two months would imply a regime change in the Warsaw secondary market.`,
    },
  ];
}
