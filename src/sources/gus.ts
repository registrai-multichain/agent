import { fetchJson, log } from "../sdk/index.js";

export interface GusCpiReading {
  /** Reference period the value covers (e.g., "2026-04" for April 2026). */
  period: string;
  /** When GUS officially published the print. */
  publishedAt: string;
  /** Year-over-year change, percent — e.g., 4.20 for 4.20%. */
  yoyPercent: number;
  /** Versioned tag for input-hash uniqueness. */
  version: string;
}

/**
 * Fetch the latest Polish CPI Y/Y reading from a registrai-hosted JSON
 * mirror of the official GUS (Główny Urząd Statystyczny) "Wskaźniki cen
 * towarów i usług konsumpcyjnych" release. See methodology
 * /methodology/polish-cpi-v1.md §3 for the source spec.
 *
 * The mirror lives at GUS_REPORT_URL — the operator updates it within 24h
 * of each official monthly publication.
 */
export async function fetchPolishCpi(reportUrl: string | undefined): Promise<GusCpiReading> {
  if (!reportUrl) {
    throw new Error("gus: GUS_REPORT_URL not set, mandatory per methodology");
  }
  const json = await fetchJson<Record<string, unknown>>(reportUrl);

  const period = json.period;
  const publishedAt = json.publishedAt;
  const yoyPercent = json.yoyPercent;
  if (
    typeof period !== "string" ||
    typeof publishedAt !== "string" ||
    typeof yoyPercent !== "number" ||
    !Number.isFinite(yoyPercent)
  ) {
    throw new Error("gus: report payload missing required fields");
  }

  log.info("gus: fetched cpi reading", { period, yoyPercent });
  return {
    period,
    publishedAt,
    yoyPercent,
    version: `${reportUrl}#${period}`,
  };
}
