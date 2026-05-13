/**
 * Polite HTTP helpers used by source scrapers. Wraps native `fetch` (works in
 * both Node 20+ and Cloudflare Workers) with retries, timeouts, and a
 * configurable user agent.
 */
import { log } from "./logger.js";

export interface FetchOptions {
  /** Max attempts before giving up. */
  retries?: number;
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Custom user agent string. */
  userAgent?: string;
  /** Headers to add. */
  headers?: Record<string, string>;
}

const DEFAULT_UA =
  "Mozilla/5.0 (compatible; registrai-agent/0.1; +https://registrai.cc)";

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers ?? {}) },
  });
  return (await res.json()) as T;
}

async function fetchWithRetry(url: string, opts: FetchOptions): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ua = opts.userAgent ?? DEFAULT_UA;

  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    attempt++;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": ua,
          ...(opts.headers ?? {}),
        },
      });
      clearTimeout(t);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt > retries) break;
      const backoff = 250 * 2 ** (attempt - 1);
      log.warn("http: retry", { url, attempt, backoff, error: (e as Error).message });
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
