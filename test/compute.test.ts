import { describe, expect, it } from "vitest";
import { hashRecords, median, trimByPercentile } from "../src/sdk/index.js";
import { computeWarsawIndex } from "../src/agents/warsaw.js";
import type { Listing } from "../src/sources/otodom.js";

function listings(values: number[]): Listing[] {
  return values.map((v, i) => ({
    id: `id-${i}`,
    pricePln: v * 50,
    areaSqm: 50,
    pricePerSqm: v,
  }));
}

const anchor = (price: number, version = "test") => ({
  reportPeriod: "2026Q1",
  observedAt: 0,
  warsawSecondaryAvgPricePerSqm: price,
  version,
});

describe("median", () => {
  it("returns middle of odd-length input", () => {
    expect(median([1, 2, 3])).toBe(2);
  });
  it("averages the two middles for even-length input", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("ignores input order", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("throws on empty input", () => {
    expect(() => median([])).toThrow();
  });
});

describe("trimByPercentile", () => {
  it("drops top and bottom 5%", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const { retained, dropped } = trimByPercentile(listings(values), 0.05, (l) => l.pricePerSqm);
    expect(dropped).toBe(10);
    expect(retained).toHaveLength(90);
    expect(retained[0]!.pricePerSqm).toBe(6);
    expect(retained[retained.length - 1]!.pricePerSqm).toBe(95);
  });

  it("is symmetric — doesn't bias", () => {
    const values = Array.from({ length: 200 }, (_, i) => i + 1);
    const { retained } = trimByPercentile(listings(values), 0.05, (l) => l.pricePerSqm);
    const med = median(retained.map((l) => l.pricePerSqm));
    expect(med).toBe(100.5);
  });
});

describe("computeWarsawIndex", () => {
  it("calibrates to the NBP anchor", () => {
    const values = Array.from({ length: 100 }, (_, i) => 10_000 + i * 100);
    const r = computeWarsawIndex({ listings: listings(values), nbpAnchor: anchor(17_000) });
    expect(r.value).toBe(17_000);
    expect(r.context.calibrationFactor).toBeGreaterThan(0);
    expect(r.context.retained).toBe(90);
  });

  it("rejects pathological calibration factors", () => {
    const values = Array.from({ length: 100 }, (_, i) => 10_000 + i * 100);
    expect(() =>
      computeWarsawIndex({ listings: listings(values), nbpAnchor: anchor(100_000) }),
    ).toThrow(/sanity bounds/);
  });

  it("refuses with too few listings", () => {
    expect(() =>
      computeWarsawIndex({ listings: listings([1, 2, 3]), nbpAnchor: anchor(17_000) }),
    ).toThrow(/too few listings/);
  });
});

describe("hashRecords", () => {
  it("is deterministic", () => {
    const records = [
      { id: "a", value: 10_000 },
      { id: "b", value: 11_000 },
      { id: "c", value: 12_000 },
    ];
    expect(hashRecords(records)).toBe(hashRecords(records));
  });

  it("is order-independent", () => {
    const a = [
      { id: "a", value: 10_000 },
      { id: "b", value: 11_000 },
      { id: "c", value: 12_000 },
    ];
    const b = [a[2]!, a[0]!, a[1]!];
    expect(hashRecords(a)).toBe(hashRecords(b));
  });

  it("changes when the tail context differs", () => {
    const records = [{ id: "a", value: 10_000 }];
    expect(hashRecords(records, 2, "nbp:v1")).not.toBe(hashRecords(records, 2, "nbp:v2"));
  });

  it("changes when a value changes", () => {
    expect(hashRecords([{ id: "a", value: 10_000 }])).not.toBe(
      hashRecords([{ id: "a", value: 10_001 }]),
    );
  });
});
