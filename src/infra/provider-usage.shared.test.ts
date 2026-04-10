import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  clampPercent,
  resolveLegacyPiAgentAccessToken,
  resolveUsageProviderId,
  withTimeout,
} from "./provider-usage.shared.js";

async function withLegacyPiAuthFile(
  contents: string,
  run: (home: string) => Promise<void> | void,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-provider-usage-" }, async (home) => {
    await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await fs.writeFile(path.join(home, ".pi", "agent", "auth.json"), contents, "utf8");
    await run(home);
  });
}

describe("provider-usage.shared", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { expected: "zai", value: "z-ai" },
    { expected: "google-gemini-cli", value: " GOOGLE-GEMINI-CLI " },
    { expected: "minimax", value: "minimax-portal" },
    { expected: "minimax", value: "minimax-cn" },
    { expected: "minimax", value: "minimax-portal-cn" },
    { expected: undefined, value: "unknown-provider" },
    { expected: undefined, value: undefined },
    { expected: undefined, value: null },
  ])("normalizes provider ids for %j", ({ value, expected }) => {
    expect(resolveUsageProviderId(value)).toBe(expected);
  });

  it.each([
    { expected: 0, value: -5 },
    { expected: 42, value: 42 },
    { expected: 100, value: 120 },
    { expected: 0, value: Number.NaN },
    { expected: 0, value: Number.POSITIVE_INFINITY },
  ])("clamps usage percents for %j", ({ value, expected }) => {
    expect(clampPercent(value)).toBe(expected);
  });

  it.each([
    {
      expected: "ok",
      name: "returns work result when it resolves before timeout",
      promise: () => Promise.resolve("ok"),
    },
    {
      error: "boom",
      name: "propagates work errors before timeout",
      promise: () => Promise.reject(new Error("boom")),
    },
  ])("$name", async ({ promise, expected, error }) => {
    if (error) {
      await expect(withTimeout(promise(), 100, "fallback")).rejects.toThrow(error);
      return;
    }
    await expect(withTimeout(promise(), 100, "fallback")).resolves.toBe(expected);
  });

  it("returns fallback when timeout wins", async () => {
    vi.useFakeTimers();
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 50));
    const result = withTimeout(late, 1, "fallback");
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("fallback");
  });

  it("clears the timeout after successful work", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(withTimeout(Promise.resolve("ok"), 100, "fallback")).resolves.toBe("ok");

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      contents: `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
      expected: "legacy-zai-key",
      name: "reads legacy pi auth tokens for known provider aliases",
    },
    {
      contents: "{not-json",
      expected: undefined,
      name: "returns undefined for invalid legacy pi auth files",
    },
  ])("$name", async ({ contents, expected }) => {
    await withLegacyPiAuthFile(contents, async (home) => {
      expect(resolveLegacyPiAgentAccessToken({ HOME: home }, ["z-ai", "zai"])).toBe(expected);
    });
  });
});
