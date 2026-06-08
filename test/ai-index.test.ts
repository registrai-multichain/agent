import { describe, expect, it } from "vitest";
import {
  sld,
  lengthClass,
  typeClass,
  computeAiIndex,
  assertAttestable,
} from "../src/agents/ai-index.js";
import type { AiSale } from "../src/sources/ai-sales.js";

function sale(domain: string, priceUsd: number, year = 2025): AiSale {
  return { domain, priceUsd, year, source: "test" };
}

describe("segmentation", () => {
  it("strips .ai and lowercases", () => {
    expect(sld("Bot.ai")).toBe("bot");
    expect(sld("H1.AI")).toBe("h1");
  });
  it("classifies length", () => {
    expect(lengthClass("z")).toBe("1");
    expect(lengthClass("os")).toBe("2");
    expect(lengthClass("bot")).toBe("3");
    expect(lengthClass("cloud")).toBe("5");
    expect(lengthClass("weather")).toBe("6-7");
    expect(lengthClass("blueprint")).toBe("8-12");
    expect(lengthClass("confidentiality")).toBe("13+");
  });
  it("classifies type structurally", () => {
    expect(typeClass("123")).toBe("numeric");
    expect(typeClass("h1")).toBe("alphanumeric");
    expect(typeClass("cloud")).toBe("alpha");
  });
});

describe("computeAiIndex", () => {
  it("throws on empty input", () => {
    expect(() => computeAiIndex([])).toThrow();
  });

  it("computes per-segment medians and a headline level", () => {
    const sales = [sale("bot.ai", 100), sale("fin.ai", 300), sale("cloud.ai", 500)];
    const r = computeAiIndex(sales);
    expect(r.value).toBe(300); // overall median
    expect(r.segmentMedians["3"]).toBe(200); // bot, fin → median(100,300)
    expect(r.segmentMedians["5"]).toBe(500); // cloud
  });

  it("flags a dense segment as markable and a sparse one as not", () => {
    // 9 three-char sales (markable, ≥8) + 1 five-char (sparse).
    const dense = Array.from({ length: 9 }, (_, i) => sale(`ab${i}.ai`, 100 + i)); // 3-char "abN"
    const sparse = [sale("cloud.ai", 500)];
    const r = computeAiIndex([...dense, ...sparse]);
    const three = r.context.byLength.find((b) => b.key === "3")!;
    const five = r.context.byLength.find((b) => b.key === "5")!;
    expect(three.markable).toBe(true);
    expect(five.markable).toBe(false);
  });

  it("reports NOT attestable when coverage is thin (the keystone result)", () => {
    // One sale in each of many segments → nothing clears MARKABLE_MIN.
    const sales = [
      sale("z.ai", 1),
      sale("os.ai", 2),
      sale("bot.ai", 3),
      sale("home.ai", 4),
      sale("cloud.ai", 5),
      sale("weather.ai", 6),
      sale("blueprint.ai", 7),
    ];
    const r = computeAiIndex(sales);
    expect(r.context.verdict.attestable).toBe(false);
    expect(() => assertAttestable(r)).toThrow(/refusing to attest/);
  });

  it("reports YoY drift only on segments dense in BOTH years", () => {
    const y1 = Array.from({ length: 8 }, (_, i) => sale(`ab${i}.ai`, 100, 2024));
    const y2 = Array.from({ length: 8 }, (_, i) => sale(`cd${i}.ai`, 150, 2025));
    const r = computeAiIndex([...y1, ...y2]);
    const drift = r.context.yoy.find((y) => y.segment === "3");
    expect(drift).toBeDefined();
    expect(drift!.pctChange).toBeCloseTo(0.5, 5); // 100 → 150
  });

  it("is deterministic (stable inputHash)", () => {
    const sales = [sale("bot.ai", 100), sale("fin.ai", 300)];
    expect(computeAiIndex(sales).inputHash).toBe(computeAiIndex(sales).inputHash);
  });
});
