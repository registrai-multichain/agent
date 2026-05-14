import { load as loadHtml } from "cheerio";
import { fetchText, sleep, log } from "@registrai/agent-sdk";

export interface Listing {
  id: string;
  pricePln: number;
  areaSqm: number;
  pricePerSqm: number;
}

export interface OtodomFetchResult {
  listings: Listing[];
  pagesFetched: number;
  fetchedAt: number;
}

/**
 * Fetch and parse Warsaw residential sale listings from Otodom by reading
 * the `__NEXT_DATA__` JSON blob. See methodology v1 §3.1.
 */
export async function fetchOtodom(baseUrl: string, maxPages = 5): Promise<OtodomFetchResult> {
  const listings: Listing[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    const html = await fetchText(url, {
      headers: { "Accept-Language": "pl,en;q=0.8" },
      timeoutMs: 20_000,
    });
    const pageListings = parseListings(html);
    if (pageListings.length === 0) break;
    listings.push(...pageListings);
    pagesFetched = page;
    await sleep(750);
  }

  log.info("otodom: fetched listings", { pagesFetched, listingCount: listings.length });

  return {
    listings,
    pagesFetched,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

export function parseListings(html: string): Listing[] {
  const $ = loadHtml(html);
  const script = $("script#__NEXT_DATA__").first().contents().text();
  if (!script) throw new Error("otodom: __NEXT_DATA__ not found — page structure changed");
  let data: unknown;
  try {
    data = JSON.parse(script);
  } catch (e) {
    throw new Error(`otodom: __NEXT_DATA__ not valid JSON: ${(e as Error).message}`);
  }

  const ads = extractAds(data);
  const out: Listing[] = [];
  for (const ad of ads) {
    const listing = adToListing(ad);
    if (listing) out.push(listing);
  }
  return out;
}

function extractAds(data: unknown): unknown[] {
  const candidatePaths = [
    ["props", "pageProps", "data", "searchAds", "items"],
    ["props", "pageProps", "data", "searchAdsRandomized", "items"],
    ["props", "pageProps", "searchAds", "items"],
  ];
  for (const path of candidatePaths) {
    const node = getIn(data, path);
    if (Array.isArray(node)) return node;
  }
  return [];
}

function getIn(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function adToListing(ad: unknown): Listing | undefined {
  if (!ad || typeof ad !== "object") return undefined;
  const a = ad as Record<string, unknown>;

  const id = stringField(a, ["id", "slug"]);
  const totalPrice = numericField(a, [
    ["totalPrice", "value"],
    ["price", "value"],
    ["price"],
  ]);
  const area = numericField(a, [["areaInSquareMeters"], ["area"]]);
  const pricePerSqmDirect = numericField(a, [["pricePerSquareMeter", "value"], ["pricePerSquareMeter"]]);

  if (!id) return undefined;

  let pricePerSqm: number | undefined;
  let priceUsed: number | undefined;
  let areaUsed: number | undefined;

  if (totalPrice && area && area > 0) {
    pricePerSqm = totalPrice / area;
    priceUsed = totalPrice;
    areaUsed = area;
  } else if (pricePerSqmDirect && area) {
    pricePerSqm = pricePerSqmDirect;
    priceUsed = pricePerSqmDirect * area;
    areaUsed = area;
  } else {
    return undefined;
  }

  if (pricePerSqm < 500 || pricePerSqm > 200_000) return undefined;
  if (areaUsed < 10 || areaUsed > 1000) return undefined;

  return { id, pricePln: priceUsed, areaSqm: areaUsed, pricePerSqm };
}

function stringField(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function numericField(
  obj: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): number | undefined {
  for (const path of paths) {
    const v = getIn(obj, path);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}
