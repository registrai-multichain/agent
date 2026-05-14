import { fetchJson, log } from "../sdk/index.js";

export interface EcbRateReading {
  /** Decision date — when the ECB Governing Council announced this rate. */
  decisionDate: string;
  /** Effective date — when the rate becomes active for refinancing operations. */
  effectiveDate: string;
  /** Main refinancing operations rate, percent — e.g., 3.00 for 3.00%. */
  mainRefiPercent: number;
  /** ECB press-release URL. */
  pressReleaseUrl: string;
  /** Versioned tag for input-hash uniqueness. */
  version: string;
}

/**
 * Fetch the latest ECB main refinancing operations rate from a
 * registrai-hosted JSON mirror of the official ECB monetary policy
 * decisions press release. See methodology /methodology/ecb-rate-v1.md §3
 * for the source spec.
 *
 * The mirror lives at ECB_REPORT_URL — the operator updates it within 1h
 * of each Governing Council decision.
 */
export async function fetchEcbRate(reportUrl: string | undefined): Promise<EcbRateReading> {
  if (!reportUrl) {
    throw new Error("ecb: ECB_REPORT_URL not set, mandatory per methodology");
  }
  const json = await fetchJson<Record<string, unknown>>(reportUrl);

  const decisionDate = json.decisionDate;
  const effectiveDate = json.effectiveDate;
  const mainRefiPercent = json.mainRefiPercent;
  const pressReleaseUrl = json.pressReleaseUrl;
  if (
    typeof decisionDate !== "string" ||
    typeof effectiveDate !== "string" ||
    typeof mainRefiPercent !== "number" ||
    typeof pressReleaseUrl !== "string" ||
    !Number.isFinite(mainRefiPercent)
  ) {
    throw new Error("ecb: report payload missing required fields");
  }

  log.info("ecb: fetched rate reading", { decisionDate, mainRefiPercent });
  return {
    decisionDate,
    effectiveDate,
    mainRefiPercent,
    pressReleaseUrl,
    version: `${reportUrl}#${decisionDate}`,
  };
}
