import { fetchJson, log } from "../sdk/index.js";

export interface NbpAnchor {
  reportPeriod: string;
  observedAt: number;
  warsawSecondaryAvgPricePerSqm: number;
  version: string;
}

/**
 * Fetch the latest NBP "Information on housing prices" anchor for Warsaw.
 * See methodology v1 §3.2 — v1 expects an operator-maintained JSON mirror.
 */
export async function fetchNbpAnchor(reportUrl: string | undefined): Promise<NbpAnchor> {
  if (!reportUrl) {
    throw new Error("nbp: NBP_REPORT_URL not set, anchor is mandatory per methodology v1");
  }
  const json = await fetchJson<Record<string, unknown>>(reportUrl);

  const period = json.period;
  const price = json.warsawSecondaryAvgPricePerSqm;
  if (typeof period !== "string" || typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error("nbp: report payload missing required fields");
  }

  log.info("nbp: fetched anchor", { period, price });
  return {
    reportPeriod: period,
    observedAt: Math.floor(Date.now() / 1000),
    warsawSecondaryAvgPricePerSqm: price,
    version: `${reportUrl}#${period}`,
  };
}
