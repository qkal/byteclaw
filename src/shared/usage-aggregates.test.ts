import { describe, expect, it } from "vitest";
import {
  buildUsageAggregateTail,
  mergeUsageDailyLatency,
  mergeUsageLatency,
} from "./usage-aggregates.js";

describe("shared/usage-aggregates", () => {
  it("merges latency totals and ignores empty inputs", () => {
    const totals = {
      count: 1,
      max: 100,
      min: 100,
      p95Max: 100,
      sum: 100,
    };

    mergeUsageLatency(totals, undefined);
    mergeUsageLatency(totals, {
      avgMs: 999,
      count: 0,
      maxMs: 999,
      minMs: 1,
      p95Ms: 999,
    });
    mergeUsageLatency(totals, {
      avgMs: 50,
      count: 2,
      maxMs: 90,
      minMs: 20,
      p95Ms: 80,
    });

    expect(totals).toEqual({
      count: 3,
      max: 100,
      min: 20,
      p95Max: 100,
      sum: 200,
    });
  });

  it("merges daily latency by date and computes aggregate tail sorting", () => {
    const dailyLatencyMap = new Map<
      string,
      {
        date: string;
        count: number;
        sum: number;
        min: number;
        max: number;
        p95Max: number;
      }
    >();

    mergeUsageDailyLatency(dailyLatencyMap, [
      { avgMs: 50, count: 2, date: "2026-03-12", maxMs: 90, minMs: 20, p95Ms: 80 },
      { avgMs: 120, count: 1, date: "2026-03-12", maxMs: 120, minMs: 120, p95Ms: 120 },
      { avgMs: 30, count: 1, date: "2026-03-11", maxMs: 30, minMs: 30, p95Ms: 30 },
    ]);
    mergeUsageDailyLatency(dailyLatencyMap, null);

    const tail = buildUsageAggregateTail({
      byChannelMap: new Map([
        ["discord", { totalCost: 4 }],
        ["telegram", { totalCost: 8 }],
      ]),
      dailyLatencyMap,
      dailyMap: new Map([
        ["b", { date: "2026-03-12" }],
        ["a", { date: "2026-03-11" }],
      ]),
      latencyTotals: {
        count: 3,
        max: 120,
        min: 20,
        p95Max: 120,
        sum: 200,
      },
      modelDailyMap: new Map([
        ["b", { cost: 1, date: "2026-03-12" }],
        ["a", { cost: 2, date: "2026-03-12" }],
        ["c", { cost: 9, date: "2026-03-11" }],
      ]),
    });

    expect(tail.byChannel.map((entry) => entry.channel)).toEqual(["telegram", "discord"]);
    expect(tail.latency).toEqual({
      avgMs: 200 / 3,
      count: 3,
      maxMs: 120,
      minMs: 20,
      p95Ms: 120,
    });
    expect(tail.dailyLatency).toEqual([
      { avgMs: 30, count: 1, date: "2026-03-11", maxMs: 30, minMs: 30, p95Ms: 30 },
      { avgMs: 220 / 3, count: 3, date: "2026-03-12", maxMs: 120, minMs: 20, p95Ms: 120 },
    ]);
    expect(tail.modelDaily).toEqual([
      { cost: 9, date: "2026-03-11" },
      { cost: 2, date: "2026-03-12" },
      { cost: 1, date: "2026-03-12" },
    ]);
    expect(tail.daily).toEqual([{ date: "2026-03-11" }, { date: "2026-03-12" }]);
  });

  it("omits latency when no requests were counted", () => {
    const tail = buildUsageAggregateTail({
      byChannelMap: new Map(),
      dailyLatencyMap: new Map(),
      dailyMap: new Map(),
      latencyTotals: {
        count: 0,
        max: 0,
        min: Number.POSITIVE_INFINITY,
        p95Max: 0,
        sum: 0,
      },
      modelDailyMap: new Map(),
    });

    expect(tail.latency).toBeUndefined();
    expect(tail.dailyLatency).toEqual([]);
  });

  it("normalizes zero-count daily latency entries to zero averages and mins", () => {
    const dailyLatencyMap = new Map([
      [
        "2026-03-12",
        {
          count: 0,
          date: "2026-03-12",
          max: 0,
          min: Number.POSITIVE_INFINITY,
          p95Max: 0,
          sum: 0,
        },
      ],
    ]);

    const tail = buildUsageAggregateTail({
      byChannelMap: new Map(),
      dailyLatencyMap,
      dailyMap: new Map(),
      latencyTotals: {
        count: 0,
        max: 0,
        min: Number.POSITIVE_INFINITY,
        p95Max: 0,
        sum: 0,
      },
      modelDailyMap: new Map(),
    });

    expect(tail.dailyLatency).toEqual([
      { avgMs: 0, count: 0, date: "2026-03-12", maxMs: 0, minMs: 0, p95Ms: 0 },
    ]);
  });
});
