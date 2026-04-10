import { describe, expect, it } from "vitest";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import {
  countMismatches,
  countRunning,
  formatImageMatch,
  formatSimpleStatus,
  formatStatus,
} from "./sandbox-formatters.js";

/** Helper matching old formatAge behavior: spaced compound duration */
const formatAge = (ms: number) => formatDurationCompact(ms, { spaced: true }) ?? "0s";

describe("sandbox-formatters", () => {
  describe("formatStatus", () => {
    it.each([
      { expected: "🟢 running", running: true },
      { expected: "⚫ stopped", running: false },
    ])("formats running=$running", ({ running, expected }) => {
      expect(formatStatus(running)).toBe(expected);
    });
  });

  describe("formatSimpleStatus", () => {
    it.each([
      { expected: "running", running: true },
      { expected: "stopped", running: false },
    ])("formats running=$running without emoji", ({ running, expected }) => {
      expect(formatSimpleStatus(running)).toBe(expected);
    });
  });

  describe("formatImageMatch", () => {
    it.each([
      { expected: "✓", imageMatch: true },
      { expected: "⚠️  mismatch", imageMatch: false },
    ])("formats imageMatch=$imageMatch", ({ imageMatch, expected }) => {
      expect(formatImageMatch(imageMatch)).toBe(expected);
    });
  });

  describe("formatAge", () => {
    it.each([
      { expected: "0s", ms: 0 },
      { expected: "5s", ms: 5000 },
      { expected: "45s", ms: 45_000 },
      { expected: "1m", ms: 60_000 },
      { expected: "1m 30s", ms: 90_000 }, // 90 seconds = 1m 30s
      { expected: "5m", ms: 300_000 },
      { expected: "1h", ms: 3_600_000 },
      { expected: "1h 1m", ms: 3_660_000 },
      { expected: "1h 30m", ms: 5_400_000 },
      { expected: "2h", ms: 7_200_000 },
      { expected: "1d", ms: 86_400_000 },
      { expected: "1d 1h", ms: 90_000_000 },
      { expected: "2d", ms: 172_800_000 },
      { expected: "2d 3h", ms: 183_600_000 },
      { expected: "1m", ms: 59_999 }, // Rounds to 1 minute exactly
      { expected: "1h", ms: 3_599_999 }, // Rounds to 1 hour exactly
      { expected: "1d", ms: 86_399_999 }, // Rounds to 1 day exactly
    ])("formats $ms ms", ({ ms, expected }) => {
      expect(formatAge(ms)).toBe(expected);
    });
  });

  describe("countRunning", () => {
    it.each([
      {
        expected: 2,
        items: [
          { name: "a", running: true },
          { name: "b", running: false },
          { name: "c", running: true },
          { name: "d", running: false },
        ],
      },
      {
        expected: 0,
        items: [
          { name: "a", running: false },
          { name: "b", running: false },
        ],
      },
      {
        expected: 3,
        items: [
          { name: "a", running: true },
          { name: "b", running: true },
          { name: "c", running: true },
        ],
      },
    ])("counts running items", ({ items, expected }) => {
      expect(countRunning(items)).toBe(expected);
    });
  });

  describe("countMismatches", () => {
    it.each([
      {
        expected: 3,
        items: [
          { imageMatch: true, name: "a" },
          { imageMatch: false, name: "b" },
          { imageMatch: true, name: "c" },
          { imageMatch: false, name: "d" },
          { imageMatch: false, name: "e" },
        ],
      },
      {
        expected: 0,
        items: [
          { imageMatch: true, name: "a" },
          { imageMatch: true, name: "b" },
        ],
      },
      {
        expected: 3,
        items: [
          { imageMatch: false, name: "a" },
          { imageMatch: false, name: "b" },
          { imageMatch: false, name: "c" },
        ],
      },
    ])("counts image mismatches", ({ items, expected }) => {
      expect(countMismatches(items)).toBe(expected);
    });
  });

  describe("counter empty inputs", () => {
    it.each([
      { fn: countRunning as (items: unknown[]) => number },
      { fn: countMismatches as (items: unknown[]) => number },
    ])("should return 0 for empty array", ({ fn }) => {
      expect(fn([])).toBe(0);
    });
  });
});
