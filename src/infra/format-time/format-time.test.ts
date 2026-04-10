import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUtcTimestamp, formatZonedTimestamp, resolveTimezone } from "./format-datetime.js";
import {
  formatDurationCompact,
  formatDurationHuman,
  formatDurationPrecise,
  formatDurationSeconds,
} from "./format-duration.js";
import { formatRelativeTimestamp, formatTimeAgo } from "./format-relative.js";

const invalidDurationInputs = [null, undefined, -100] as const;

function expectFormatterCases<TInput, TOutput>(
  formatter: (value: TInput) => TOutput,
  cases: readonly { input: TInput; expected: TOutput }[],
) {
  for (const { input, expected } of cases) {
    expect(formatter(input), String(input)).toBe(expected);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("format-duration", () => {
  describe("formatDurationCompact", () => {
    it.each([null, undefined, 0, -100])("returns undefined for %j", (value) => {
      expect(formatDurationCompact(value)).toBeUndefined();
    });

    it("formats compact units and omits trailing zero components", () => {
      expectFormatterCases(formatDurationCompact, [
        { expected: "500ms", input: 500 },
        { expected: "999ms", input: 999 },
        { expected: "1s", input: 1000 },
        { expected: "45s", input: 45_000 },
        { expected: "59s", input: 59_000 },
        { expected: "1m", input: 60_000 },
        { expected: "1m5s", input: 65_000 },
        { expected: "1m30s", input: 90_000 },
        { expected: "1h", input: 3_600_000 },
        { expected: "1h1m", input: 3_660_000 },
        { expected: "1h30m", input: 5_400_000 },
        { expected: "1d", input: 86_400_000 },
        { expected: "1d1h", input: 90_000_000 },
        { expected: "2d", input: 172_800_000 },
      ]);
    });

    it.each([
      { expected: "1m 5s", input: 65_000, options: { spaced: true } },
      { expected: "1h 1m", input: 3_660_000, options: { spaced: true } },
      { expected: "1d 1h", input: 90_000_000, options: { spaced: true } },
      { expected: "1m", input: 59_500 },
      { expected: "59s", input: 59_400 },
    ])("formats compact duration for %j", ({ input, options, expected }) => {
      expect(formatDurationCompact(input, options)).toBe(expected);
    });
  });

  describe("formatDurationHuman", () => {
    it("returns fallback for invalid duration input", () => {
      for (const value of invalidDurationInputs) {
        expect(formatDurationHuman(value)).toBe("n/a");
      }
      expect(formatDurationHuman(null, "unknown")).toBe("unknown");
    });

    it("formats single-unit outputs and day threshold behavior", () => {
      expectFormatterCases(formatDurationHuman, [
        { expected: "500ms", input: 500 },
        { expected: "5s", input: 5000 },
        { expected: "3m", input: 180_000 },
        { expected: "2h", input: 7_200_000 },
        { expected: "23h", input: 23 * 3_600_000 },
        { expected: "1d", input: 24 * 3_600_000 },
        { expected: "1d", input: 25 * 3_600_000 },
        { expected: "2d", input: 172_800_000 },
      ]);
    });
  });

  describe("formatDurationPrecise", () => {
    it.each([
      { expected: "500ms", input: 500 },
      { expected: "999ms", input: 999 },
      { expected: "0ms", input: -1 },
      { expected: "0ms", input: -500 },
      { expected: "1000ms", input: 999.6 },
      { expected: "1s", input: 1000 },
      { expected: "1.5s", input: 1500 },
      { expected: "1.23s", input: 1234 },
      { expected: "unknown", input: Number.NaN },
      { expected: "unknown", input: Infinity },
    ])("formats precise duration for %j", ({ input, expected }) => {
      expect(formatDurationPrecise(input)).toBe(expected);
    });
  });

  describe("formatDurationSeconds", () => {
    it.each([
      { expected: "1.5s", input: 1500, options: { decimals: 1 } },
      { expected: "1.23s", input: 1234, options: { decimals: 2 } },
      { expected: "1s", input: 1000, options: { decimals: 0 } },
      { expected: "2 seconds", input: 2000, options: { unit: "seconds" as const } },
      { expected: "0s", input: -1500, options: { decimals: 1 } },
      { expected: "unknown", input: Number.NaN, options: undefined },
      { expected: "unknown", input: Infinity, options: undefined },
    ])("formats seconds duration for %j", ({ input, options, expected }) => {
      expect(formatDurationSeconds(input, options)).toBe(expected);
    });
  });
});

describe("format-datetime", () => {
  describe("resolveTimezone", () => {
    it.each([
      { expected: "America/New_York", input: "America/New_York" },
      { expected: "Europe/London", input: "Europe/London" },
      { expected: "UTC", input: "UTC" },
      { expected: undefined, input: "Invalid/Timezone" },
      { expected: undefined, input: "garbage" },
      { expected: undefined, input: "" },
    ] as const)("resolves $input", ({ input, expected }) => {
      expect(resolveTimezone(input)).toBe(expected);
    });
  });

  describe("formatUtcTimestamp", () => {
    it.each([
      { displaySeconds: false, expected: "2024-01-15T14:30Z" },
      { displaySeconds: true, expected: "2024-01-15T14:30:45Z" },
    ])("formats UTC timestamp (displaySeconds=$displaySeconds)", ({ displaySeconds, expected }) => {
      const date = new Date("2024-01-15T14:30:45.000Z");
      const result = displaySeconds
        ? formatUtcTimestamp(date, { displaySeconds: true })
        : formatUtcTimestamp(date);
      expect(result).toBe(expected);
    });
  });

  describe("formatZonedTimestamp", () => {
    it.each([
      {
        date: new Date("2024-01-15T14:30:00.000Z"),
        expected: /2024-01-15 14:30/,
        options: { timeZone: "UTC" },
      },
      {
        date: new Date("2024-01-15T14:30:45.000Z"),
        expected: /2024-01-15 14:30:45/,
        options: { displaySeconds: true, timeZone: "UTC" },
      },
    ] as const)("formats zoned timestamp", ({ date, options, expected }) => {
      const result = formatZonedTimestamp(date, options);
      expect(result).toMatch(expected);
    });

    it("returns undefined when required Intl parts are missing", () => {
      function MissingPartsDateTimeFormat() {
        return {
          formatToParts: () => [
            { type: "month", value: "01" },
            { type: "day", value: "15" },
            { type: "hour", value: "14" },
            { type: "minute", value: "30" },
          ],
        } as Intl.DateTimeFormat;
      }

      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
        MissingPartsDateTimeFormat as unknown as typeof Intl.DateTimeFormat,
      );

      expect(formatZonedTimestamp(new Date("2024-01-15T14:30:00.000Z"), { timeZone: "UTC" })).toBe(
        undefined,
      );
    });

    it("returns undefined when Intl formatting throws", () => {
      function ThrowingDateTimeFormat() {
        return {
          formatToParts: () => {
            throw new Error("boom");
          },
        } as unknown as Intl.DateTimeFormat;
      }

      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
        ThrowingDateTimeFormat as unknown as typeof Intl.DateTimeFormat,
      );

      expect(formatZonedTimestamp(new Date("2024-01-15T14:30:00.000Z"), { timeZone: "UTC" })).toBe(
        undefined,
      );
    });
  });
});

describe("format-relative", () => {
  describe("formatTimeAgo", () => {
    it("returns fallback for invalid elapsed input", () => {
      for (const value of invalidDurationInputs) {
        expect(formatTimeAgo(value)).toBe("unknown");
      }
      expect(formatTimeAgo(null, { fallback: "n/a" })).toBe("n/a");
    });

    it("formats relative age around key unit boundaries", () => {
      expectFormatterCases(formatTimeAgo, [
        { expected: "just now", input: 0 },
        { expected: "just now", input: 29_000 },
        { expected: "1m ago", input: 30_000 },
        { expected: "5m ago", input: 300_000 },
        { expected: "2h ago", input: 7_200_000 },
        { expected: "47h ago", input: 47 * 3_600_000 },
        { expected: "2d ago", input: 48 * 3_600_000 },
        { expected: "2d ago", input: 172_800_000 },
      ]);
    });

    it.each([
      { expected: "0s", input: 0 },
      { expected: "5m", input: 300_000 },
      { expected: "2h", input: 7_200_000 },
    ])("omits suffix for %j when disabled", ({ input, expected }) => {
      expect(formatTimeAgo(input, { suffix: false })).toBe(expected);
    });
  });

  describe("formatRelativeTimestamp", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-02-10T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns fallback for invalid timestamp input", () => {
      for (const value of [null, undefined]) {
        expect(formatRelativeTimestamp(value)).toBe("n/a");
      }
      expect(formatRelativeTimestamp(null, { fallback: "unknown" })).toBe("unknown");
    });

    it.each([
      { expected: "just now", offsetMs: -10_000 },
      { expected: "just now", offsetMs: -30_000 },
      { expected: "5m ago", offsetMs: -300_000 },
      { expected: "2h ago", offsetMs: -7_200_000 },
      { expected: "47h ago", offsetMs: -(47 * 3_600_000) },
      { expected: "2d ago", offsetMs: -(48 * 3_600_000) },
      { expected: "in <1m", offsetMs: 30_000 },
      { expected: "in 5m", offsetMs: 300_000 },
      { expected: "in 2h", offsetMs: 7_200_000 },
    ])("formats relative timestamp for offset $offsetMs", ({ offsetMs, expected }) => {
      expect(formatRelativeTimestamp(Date.now() + offsetMs)).toBe(expected);
    });

    it.each([
      {
        expected: "7d ago",
        name: "keeps 7-day-old timestamps relative",
        offsetMs: -7 * 24 * 3_600_000,
        options: { dateFallback: true, timezone: "UTC" },
      },
      {
        expected: "Feb 2",
        name: "falls back to a short date once the timestamp is older than 7 days",
        offsetMs: -8 * 24 * 3_600_000,
        options: { dateFallback: true, timezone: "UTC" },
      },
      {
        expected: "8d ago",
        name: "keeps relative output when date fallback is disabled",
        offsetMs: -8 * 24 * 3_600_000,
        options: { timezone: "UTC" },
      },
    ])("$name", ({ offsetMs, options, expected }) => {
      expect(formatRelativeTimestamp(Date.now() + offsetMs, options)).toBe(expected);
    });

    it("falls back to relative days when date formatting throws", () => {
      expect(
        formatRelativeTimestamp(Date.now() - 8 * 24 * 3_600_000, {
          dateFallback: true,
          timezone: "Invalid/Timezone",
        }),
      ).toBe("8d ago");
    });
  });
});
