import { describe, expect, it } from "vitest";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  formatUsageWindowSummary,
} from "./provider-usage.format.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

const now = Date.UTC(2026, 0, 7, 12, 0, 0);

function makeSnapshot(windows: ProviderUsageSnapshot["windows"]): ProviderUsageSnapshot {
  return {
    displayName: "Claude",
    provider: "anthropic",
    windows,
  };
}

describe("provider-usage.format", () => {
  it.each([
    { now, snapshot: { ...makeSnapshot([]), error: "HTTP 401" } as ProviderUsageSnapshot },
    { now, snapshot: makeSnapshot([]) },
  ])("returns null summary for empty or errored snapshots", ({ snapshot, now: currentNow }) => {
    expect(formatUsageWindowSummary(snapshot, { now: currentNow })).toBeNull();
  });

  it("formats reset windows across now/minute/hour/day/date buckets", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "Now", resetAt: now - 1, usedPercent: 10 },
        { label: "Minute", resetAt: now + 30 * 60_000, usedPercent: 20 },
        { label: "Hour", resetAt: now + 2 * 60 * 60_000 + 15 * 60_000, usedPercent: 30 },
        { label: "Day", resetAt: now + (2 * 24 + 3) * 60 * 60_000, usedPercent: 40 },
        { label: "Date", resetAt: Date.UTC(2026, 0, 20, 12, 0, 0), usedPercent: 50 },
      ]),
      { includeResets: true, now },
    );

    expect(summary).toContain("Now 90% left ⏱now");
    expect(summary).toContain("Minute 80% left ⏱30m");
    expect(summary).toContain("Hour 70% left ⏱2h 15m");
    expect(summary).toContain("Day 60% left ⏱2d 3h");
    expect(summary).toMatch(/Date 50% left ⏱[A-Z][a-z]{2} \d{1,2}/);
  });

  it("honors max windows and reset toggle", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "A", resetAt: now + 60_000, usedPercent: 10 },
        { label: "B", resetAt: now + 120_000, usedPercent: 20 },
        { label: "C", resetAt: now + 180_000, usedPercent: 30 },
      ]),
      { includeResets: false, maxWindows: 2, now },
    );

    expect(summary).toBe("A 90% left · B 80% left");
  });

  it("treats non-positive max windows as all windows and clamps overused percentages", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "Over", resetAt: now + 60_000, usedPercent: 120 },
        { label: "Under", usedPercent: -10 },
      ]),
      { includeResets: true, maxWindows: 0, now },
    );

    expect(summary).toBe("Over 0% left ⏱1m · Under 100% left");
  });

  it("formats summary line from highest-usage window and provider cap", () => {
    const summary: UsageSummary = {
      providers: [
        {
          displayName: "Claude",
          provider: "anthropic",
          windows: [
            { label: "5h", usedPercent: 20 },
            { label: "Week", usedPercent: 70 },
          ],
        },
        {
          displayName: "z.ai",
          provider: "zai",
          windows: [{ label: "Day", usedPercent: 10 }],
        },
      ],
      updatedAt: now,
    };

    expect(formatUsageSummaryLine(summary, { maxProviders: 1, now })).toBe(
      "📊 Usage: Claude 30% left (Week)",
    );
  });

  it("returns null summary line when providers are errored or have no windows", () => {
    expect(
      formatUsageSummaryLine({
        providers: [
          {
            displayName: "Claude",
            error: "HTTP 401",
            provider: "anthropic",
            windows: [],
          },
          {
            displayName: "z.ai",
            provider: "zai",
            windows: [],
          },
        ],
        updatedAt: now,
      }),
    ).toBeNull();
  });

  it.each([
    {
      expected: ["Usage: no provider usage available."],
      name: "formats empty reports",
      opts: undefined,
      summary: { providers: [], updatedAt: now } as UsageSummary,
    },
    {
      expected: ["Usage:", "  Codex (Plus): Token expired", "  Xiaomi: no data"],
      name: "formats error, no-data, and plan entries",
      opts: undefined,
      summary: {
        providers: [
          {
            provider: "openai-codex",
            displayName: "Codex",
            windows: [],
            error: "Token expired",
            plan: "Plus",
          },
          {
            provider: "xiaomi",
            displayName: "Xiaomi",
            windows: [],
          },
        ],
        updatedAt: now,
      } as UsageSummary,
    },
    {
      expected: ["Usage:", "  Claude (Pro)", "    Daily: 75% left · resets 2h"],
      name: "formats detailed report lines with reset windows",
      opts: { now },
      summary: {
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            plan: "Pro",
            windows: [{ label: "Daily", usedPercent: 25, resetAt: now + 2 * 60 * 60_000 }],
          },
        ],
        updatedAt: now,
      } as UsageSummary,
    },
  ])("$name", ({ summary, opts, expected }) => {
    expect(formatUsageReportLines(summary, opts)).toEqual(expected);
  });
});
