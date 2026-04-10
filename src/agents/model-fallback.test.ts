import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isAnthropicBillingError } from "./live-auth-keys.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { runWithImageModelFallback, runWithModelFallback } from "./model-fallback.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

const makeCfg = makeModelFallbackCfg;

function makeFallbacksOnlyCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          fallbacks: ["openai/gpt-5.2"],
        },
      },
    },
  } as OpenClawConfig;
}

function makeProviderFallbackCfg(provider: string): OpenClawConfig {
  return makeCfg({
    agents: {
      defaults: {
        model: {
          fallbacks: ["fallback/ok-model"],
          primary: `${provider}/m1`,
        },
      },
    },
  });
}

async function withTempAuthStore<T>(
  store: AuthProfileStore,
  run: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
  saveAuthProfileStore(store, tempDir);
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function runWithStoredAuth(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  run: (provider: string, model: string) => Promise<string>;
}) {
  return withTempAuthStore(params.store, async (tempDir) =>
    runWithModelFallback({
      agentDir: tempDir,
      cfg: params.cfg,
      model: "m1",
      provider: params.provider,
      run: params.run,
    }),
  );
}

async function expectFallsBackToHaiku(params: {
  provider: string;
  model: string;
  firstError: Error;
}) {
  const cfg = makeCfg();
  const run = vi.fn().mockRejectedValueOnce(params.firstError).mockResolvedValueOnce("ok");

  const result = await runWithModelFallback({
    cfg,
    model: params.model,
    provider: params.provider,
    run,
  });

  expect(result.result).toBe("ok");
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toBe("anthropic");
  expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
}

function createOverrideFailureRun(params: {
  overrideProvider: string;
  overrideModel: string;
  fallbackProvider: string;
  fallbackModel: string;
  firstError: Error;
}) {
  return vi.fn().mockImplementation(async (provider, model) => {
    if (provider === params.overrideProvider && model === params.overrideModel) {
      throw params.firstError;
    }
    if (provider === params.fallbackProvider && model === params.fallbackModel) {
      return "ok";
    }
    throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
  });
}

function makeSingleProviderStore(params: {
  provider: string;
  usageStat: NonNullable<AuthProfileStore["usageStats"]>[string];
}): AuthProfileStore {
  const profileId = `${params.provider}:default`;
  return {
    profiles: {
      [profileId]: {
        key: "test-key",
        provider: params.provider,
        type: "api_key",
      },
    },
    usageStats: {
      [profileId]: params.usageStat,
    },
    version: AUTH_STORE_VERSION,
  };
}

function createFallbackOnlyRun() {
  return vi.fn().mockImplementation(async (providerId, modelId) => {
    if (providerId === "fallback") {
      return "ok";
    }
    throw new Error(`unexpected provider: ${providerId}/${modelId}`);
  });
}

async function expectSkippedUnavailableProvider(params: {
  providerPrefix: string;
  usageStat: NonNullable<AuthProfileStore["usageStats"]>[string];
  expectedReason: string;
}) {
  const provider = `${params.providerPrefix}-${crypto.randomUUID()}`;
  const cfg = makeProviderFallbackCfg(provider);
  const primaryStore = makeSingleProviderStore({
    provider,
    usageStat: params.usageStat,
  });
  // Include fallback provider profile so the fallback is attempted (not skipped as no-profile).
  const store: AuthProfileStore = {
    ...primaryStore,
    profiles: {
      ...primaryStore.profiles,
      "fallback:default": {
        key: "test-key",
        provider: "fallback",
        type: "api_key",
      },
    },
  };
  const run = createFallbackOnlyRun();

  const result = await runWithStoredAuth({
    cfg,
    provider,
    run,
    store,
  });

  expect(result.result).toBe("ok");
  expect(run.mock.calls).toEqual([["fallback", "ok-model"]]);
  expect(result.attempts[0]?.reason).toBe(params.expectedReason);
}

// OpenAI 429 example shape: https://help.openai.com/en/articles/5955604-how-can-i-solve-429-too-many-requests-errors
const OPENAI_RATE_LIMIT_MESSAGE =
  "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min. Current: 3.000000 / min.";
// Anthropic overloaded_error example shape: https://docs.anthropic.com/en/api/errors
const ANTHROPIC_OVERLOADED_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}';
// Issue-backed Anthropic/OpenAI-compatible insufficient_quota payload under HTTP 400:
// https://github.com/openclaw/openclaw/issues/23440
const INSUFFICIENT_QUOTA_PAYLOAD =
  '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';
// Internal OpenClaw compatibility marker, not a provider API contract.
const MODEL_COOLDOWN_MESSAGE = "model_cooldown: All credentials for model gpt-5 are cooling down";
// SDK/transport compatibility marker, not a provider API contract.
const CONNECTION_ERROR_MESSAGE = "Connection error.";

describe("runWithModelFallback", () => {
  it("keeps openai gpt-5.3 codex on the openai provider before running", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "gpt-5.4",
      provider: "openai",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-5.4");
  });

  it("falls back on unrecognized errors when candidates remain", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockRejectedValueOnce(new Error("bad request")).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "gpt-4.1-mini",
      provider: "openai",
      run,
    });
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].error).toBe("bad request");
    expect(result.attempts[0].reason).toBe("unknown");
  });

  it("passes original unknown errors to onError during fallback", async () => {
    const cfg = makeCfg();
    const unknownError = new Error("provider misbehaved");
    const run = vi.fn().mockRejectedValueOnce(unknownError).mockResolvedValueOnce("ok");
    const onError = vi.fn();

    await runWithModelFallback({
      cfg,
      model: "gpt-4.1-mini",
      onError,
      provider: "openai",
      run,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      model: "gpt-4.1-mini",
      provider: "openai",
      total: 2,
    });
    expect(onError.mock.calls[0]?.[0]?.error).toBe(unknownError);
  });

  it("throws unrecognized error on last candidate", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockRejectedValueOnce(new Error("something weird"));

    await expect(
      runWithModelFallback({
        cfg,
        fallbacksOverride: [],
        model: "gpt-4.1-mini",
        provider: "openai",
        run,
      }),
    ).rejects.toThrow("something weird");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("treats LiveSessionModelSwitchError as failover on last candidate (#58466)", async () => {
    const cfg = makeCfg();
    const switchError = new LiveSessionModelSwitchError({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    // With no fallbacks, the single candidate is also the last one.
    // Previously this would re-throw LiveSessionModelSwitchError, causing
    // The outer retry loop to restart with the overloaded model indefinitely.
    // Now it should surface as a FailoverError instead.
    const err = await runWithModelFallback({
      cfg,
      fallbacksOverride: [],
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      run,
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    // Should NOT be a LiveSessionModelSwitchError — the outer retry loop must
    // Not restart with the conflicting model.
    expect(err).not.toBeInstanceOf(LiveSessionModelSwitchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues fallback chain past LiveSessionModelSwitchError to next candidate (#58466)", async () => {
    const cfg = makeCfg();
    const switchError = new LiveSessionModelSwitchError({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });
    const run = vi.fn().mockRejectedValueOnce(switchError).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "gpt-4.1-mini",
      provider: "openai",
      run,
    });
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("falls back on auth errors", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("nope"), { status: 401 }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back directly to configured primary when an override model fails", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-haiku-3-5", "openrouter/deepseek-chat"],
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });

    const run = createOverrideFailureRun({
      fallbackModel: "gpt-4.1-mini",
      fallbackProvider: "openai",
      firstError: Object.assign(new Error("unauthorized"), { status: 401 }),
      overrideModel: "claude-opus-4-5",
      overrideProvider: "anthropic",
    });

    const result = await runWithModelFallback({
      cfg,
      model: "claude-opus-4-5",
      provider: "anthropic",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4-5"],
      ["openai", "gpt-4.1-mini"],
    ]);
  });

  it("keeps configured fallback chain when current model is a configured fallback", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-haiku-3-5", "openrouter/deepseek-chat"],
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });

    const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
      if (provider === "anthropic" && model === "claude-haiku-3-5") {
        throw Object.assign(new Error("rate-limited"), { status: 429 });
      }
      if (provider === "openrouter" && model === "openrouter/deepseek-chat") {
        return "ok";
      }
      throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
    });

    const result = await runWithModelFallback({
      cfg,
      model: "claude-haiku-3-5",
      provider: "anthropic",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("openrouter/deepseek-chat");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-haiku-3-5"],
      ["openrouter", "openrouter/deepseek-chat"],
    ]);
  });

  it("treats normalized default refs as primary and keeps configured fallback chain", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-haiku-3-5"],
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });

    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 401 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "gpt-4.1-mini",
      provider: " OpenAI ",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["openai", "gpt-4.1-mini"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("falls back on transient HTTP 5xx errors", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error(
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      ),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on 402 payment required", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("payment required"), { status: 402 }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on billing errors", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error(
        "LLM request rejected: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("records 400 insufficient_quota payloads as billing during fallback", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error(INSUFFICIENT_QUOTA_PAYLOAD), { status: 400 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "gpt-4.1-mini",
      provider: "openai",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.reason).toBe("billing");
  });

  it("falls back to configured primary for override credential validation errors", async () => {
    const cfg = makeCfg();
    const run = createOverrideFailureRun({
      fallbackModel: "gpt-4.1-mini",
      fallbackProvider: "openai",
      firstError: new Error('No credentials found for profile "anthropic:default".'),
      overrideModel: "claude-opus-4",
      overrideProvider: "anthropic",
    });

    const result = await runWithModelFallback({
      cfg,
      model: "claude-opus-4",
      provider: "anthropic",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4"],
      ["openai", "gpt-4.1-mini"],
    ]);
  });

  it("falls back on unknown model errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unknown model: anthropic/claude-opus-4-6"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "claude-opus-4-6",
      provider: "anthropic",
      run,
    });

    // Override model failed with model_not_found → falls back to configured primary.
    // (Same candidate-resolution path as other override-model failures.)
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-4.1-mini");
  });

  it("falls back on model not found errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Model not found: openai/gpt-6"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "gpt-6",
      provider: "openai",
      run,
    });

    // Override model failed with model_not_found → tries fallbacks first (same provider).
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("warns when falling back due to model_not_found", async () => {
    setLoggerOverride({ consoleLevel: "warn", level: "silent" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Model not found: openai/gpt-6"))
        .mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        model: "gpt-6",
        provider: "openai",
        run,
      });

      expect(result.result).toBe("ok");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "openai/gpt-6" not found'),
      );
    } finally {
      warnSpy.mockRestore();
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("sanitizes model identifiers in model_not_found warnings", async () => {
    const warnLogs = createWarnLogCapture("openclaw-model-fallback-test");
    try {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Model not found: openai/gpt-6"))
        .mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        model: "gpt-6\u001B[31m\nspoof",
        provider: "openai",
        run,
      });

      expect(result.result).toBe("ok");
      const warning = warnLogs.findText('Model "openai/gpt-6spoof" not found');
      expect(warning).toContain('Model "openai/gpt-6spoof" not found');
      expect(warning).not.toContain("\u001B");
      expect(warning).not.toContain("\n");
    } finally {
      warnLogs.cleanup();
    }
  });

  it("skips providers when all profiles are in cooldown", async () => {
    await expectSkippedUnavailableProvider({
      expectedReason: "unknown",
      providerPrefix: "cooldown-test",
      usageStat: {
        cooldownUntil: Date.now() + 5 * 60_000,
      },
    });
  });

  it("does not skip OpenRouter when legacy cooldown markers exist", async () => {
    const provider = "openrouter";
    const cfg = makeProviderFallbackCfg(provider);
    const store = makeSingleProviderStore({
      provider,
      usageStat: {
        cooldownUntil: Date.now() + 5 * 60_000,
        disabledReason: "billing",
        disabledUntil: Date.now() + 10 * 60_000,
      },
    });
    const run = vi.fn().mockImplementation(async (providerId) => {
      if (providerId === "openrouter") {
        return "ok";
      }
      throw new Error(`unexpected provider: ${providerId}`);
    });

    const result = await runWithStoredAuth({
      cfg,
      provider,
      run,
      store,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("openrouter");
    expect(result.attempts).toEqual([]);
  });

  it("propagates disabled reason when all profiles are unavailable", async () => {
    const now = Date.now();
    await expectSkippedUnavailableProvider({
      expectedReason: "billing",
      providerPrefix: "disabled-test",
      usageStat: {
        disabledReason: "billing",
        disabledUntil: now + 5 * 60_000,
        failureCounts: { rate_limit: 4 },
      },
    });
  });

  it("does not skip when any profile is available", async () => {
    const provider = `cooldown-mixed-${crypto.randomUUID()}`;
    const profileA = `${provider}:a`;
    const profileB = `${provider}:b`;

    const store: AuthProfileStore = {
      profiles: {
        [profileA]: {
          key: "key-a",
          provider,
          type: "api_key",
        },
        [profileB]: {
          key: "key-b",
          provider,
          type: "api_key",
        },
      },
      usageStats: {
        [profileA]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
      version: AUTH_STORE_VERSION,
    };

    const cfg = makeProviderFallbackCfg(provider);
    const run = vi.fn().mockImplementation(async (providerId) => {
      if (providerId === provider) {
        return "ok";
      }
      return "unexpected";
    });

    const result = await runWithStoredAuth({
      cfg,
      provider,
      run,
      store,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([[provider, "m1"]]);
    expect(result.attempts).toEqual([]);
  });

  it("does not append configured primary when fallbacksOverride is set", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockImplementation(() => Promise.reject(Object.assign(new Error("nope"), { status: 401 })));

    await expect(
      runWithModelFallback({
        cfg,
        fallbacksOverride: ["anthropic/claude-haiku-3-5"],
        model: "claude-opus-4-5",
        provider: "anthropic",
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4-5"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("refreshes cooldown expiry from persisted auth state before fallback summary", async () => {
    const expiry = Date.now() + 120_000;
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
            primary: "anthropic/claude-opus-4-5",
          },
        },
      },
    });
    const store: AuthProfileStore = {
      profiles: {
        "anthropic:default": { key: "anthropic-key", provider: "anthropic", type: "api_key" },
        "openai:default": { key: "openai-key", provider: "openai", type: "api_key" },
      },
      version: AUTH_STORE_VERSION,
    };

    await withTempAuthStore(store, async (tempDir) => {
      const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
        if (provider === "anthropic" && model === "claude-opus-4-5") {
          saveAuthProfileStore(
            {
              ...store,
              usageStats: {
                "anthropic:default": {
                  cooldownModel: "claude-opus-4-5",
                  cooldownReason: "rate_limit",
                  cooldownUntil: expiry,
                  failureCounts: { rate_limit: 1 },
                },
              },
            },
            tempDir,
          );
        }

        throw Object.assign(new Error("rate limited"), { status: 429 });
      });

      await expect(
        runWithModelFallback({
          agentDir: tempDir,
          cfg,
          model: "claude-opus-4-5",
          provider: "anthropic",
          run,
        }),
      ).rejects.toMatchObject({
        name: "FallbackSummaryError",
        soonestCooldownExpiry: expiry,
      });
    });
  });

  it("filters fallback summary cooldown expiry to attempted model scopes", async () => {
    const now = Date.now();
    const unrelatedExpiry = now + 15_000;
    const relevantExpiry = now + 90_000;
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
            primary: "anthropic/claude-opus-4-5",
          },
        },
      },
    });
    const store: AuthProfileStore = {
      profiles: {
        "anthropic:default": { key: "anthropic-key", provider: "anthropic", type: "api_key" },
        "openai:default": { key: "openai-key", provider: "openai", type: "api_key" },
      },
      usageStats: {
        "anthropic:default": {
          cooldownModel: "claude-haiku-3-5",
          cooldownReason: "rate_limit",
          cooldownUntil: unrelatedExpiry,
          failureCounts: { rate_limit: 1 },
        },
        "openai:default": {
          cooldownModel: "gpt-5.2",
          cooldownReason: "rate_limit",
          cooldownUntil: relevantExpiry,
          failureCounts: { rate_limit: 1 },
        },
      },
      version: AUTH_STORE_VERSION,
    };

    await withTempAuthStore(store, async (tempDir) => {
      const run = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));

      await expect(
        runWithModelFallback({
          agentDir: tempDir,
          cfg,
          model: "claude-opus-4-5",
          provider: "anthropic",
          run,
        }),
      ).rejects.toMatchObject({
        name: "FallbackSummaryError",
        soonestCooldownExpiry: relevantExpiry,
      });
    });
  });

  it("uses fallbacksOverride instead of agents.defaults.model.fallbacks", async () => {
    const cfg = makeFallbacksOnlyCfg();

    const calls: { provider: string; model: string }[] = [];

    const res = await runWithModelFallback({
      cfg,
      fallbacksOverride: ["openai/gpt-4.1"],
      model: "claude-opus-4-5",
      provider: "anthropic",
      run: async (provider, model) => {
        calls.push({ model, provider });
        if (provider === "anthropic") {
          throw Object.assign(new Error("nope"), { status: 401 });
        }
        if (provider === "openai" && model === "gpt-4.1") {
          return "ok";
        }
        throw new Error(`unexpected candidate: ${provider}/${model}`);
      },
    });

    expect(res.result).toBe("ok");
    expect(calls).toEqual([
      { model: "claude-opus-4-5", provider: "anthropic" },
      { model: "gpt-4.1", provider: "openai" },
    ]);
  });

  it("treats an empty fallbacksOverride as disabling global fallbacks", async () => {
    const cfg = makeFallbacksOnlyCfg();

    const calls: { provider: string; model: string }[] = [];

    await expect(
      runWithModelFallback({
        cfg,
        fallbacksOverride: [],
        model: "claude-opus-4-5",
        provider: "anthropic",
        run: async (provider, model) => {
          calls.push({ model, provider });
          throw new Error("primary failed");
        },
      }),
    ).rejects.toThrow("primary failed");

    expect(calls).toEqual([{ model: "claude-opus-4-5", provider: "anthropic" }]);
  });

  it("keeps explicit fallbacks reachable when models allowlist is present", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-4o", "ollama/llama-3"],
            primary: "anthropic/claude-sonnet-4",
          },
          models: {
            "anthropic/claude-sonnet-4": {},
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "claude-sonnet-4",
      provider: "anthropic",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-sonnet-4"],
      ["openai", "gpt-4o"],
    ]);
  });

  it("defaults provider/model when missing (regression #946)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: [],
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });

    const calls: { provider: string; model: string }[] = [];

    const result = await runWithModelFallback({
      cfg,
      model: undefined as unknown as string,
      provider: undefined as unknown as string,
      run: async (provider, model) => {
        calls.push({ model, provider });
        return "ok";
      },
    });

    expect(result.result).toBe("ok");
    expect(calls).toEqual([{ model: "gpt-4.1-mini", provider: "openai" }]);
  });

  it("falls back on missing API key errors", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error("No API key found for profile openai."),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on lowercase credential errors", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error("no api key found for profile openai"),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on documented OpenAI 429 rate limit responses", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error(OPENAI_RATE_LIMIT_MESSAGE), { status: 429 }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on documented overloaded_error payloads", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error(ANTHROPIC_OVERLOADED_PAYLOAD),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on internal model cooldown markers", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error(MODEL_COOLDOWN_MESSAGE),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on compatibility connection error messages", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error(CONNECTION_ERROR_MESSAGE),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on timeout abort errors", async () => {
    const timeoutCause = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("aborted"), { cause: timeoutCause, name: "AbortError" }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on abort errors with timeout reasons", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("aborted"), {
        name: "AbortError",
        reason: "deadline exceeded",
      }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on abort errors with reason: abort", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("aborted"), {
        name: "AbortError",
        reason: "reason: abort",
      }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on unhandled stop reason error responses", async () => {
    await expectFallsBackToHaiku({
      firstError: new Error("Unhandled stop reason: error"),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on abort errors with reason: error", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("aborted"), {
        name: "AbortError",
        reason: "reason: error",
      }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back when message says aborted but error is a timeout", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("request aborted"), { code: "ETIMEDOUT" }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on ECONNREFUSED (local server down or remote unreachable)", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
        code: "ECONNREFUSED",
      }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on ENETUNREACH (network disconnected)", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on EHOSTUNREACH (host unreachable)", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on EAI_AGAIN (DNS resolution failure)", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("getaddrinfo EAI_AGAIN api.openai.com"), {
        code: "EAI_AGAIN",
      }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on ENETRESET (connection reset by network)", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("connect ENETRESET"), { code: "ENETRESET" }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("falls back on provider abort errors with request-aborted messages", async () => {
    await expectFallsBackToHaiku({
      firstError: Object.assign(new Error("Request was aborted"), { name: "AbortError" }),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
  });

  it("does not fall back on user aborts", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        model: "gpt-4.1-mini",
        provider: "openai",
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("appends the configured primary as a last fallback", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            fallbacks: [],
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      model: "meta-llama/llama-3.3-70b:free",
      provider: "openrouter",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
  });

  // Tests for Bug A fix: Model fallback with session overrides
  describe("fallback behavior with session model overrides", () => {
    it("allows fallbacks when session model differs from config within same provider", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-5", "google/gemini-2.5-flash"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Rate limit exceeded")) // Session model fails
        .mockResolvedValueOnce("fallback success"); // First fallback succeeds

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514", // Different from config primary
        run,
      });

      expect(result.result).toBe("fallback success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-20250514");
      expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-sonnet-4-5"); // Fallback tried
    });

    it("allows fallbacks with model version differences within same provider", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Weekly quota exceeded"))
        .mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5", // Version difference from config
        run,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });

    it("still skips fallbacks when using different provider than config", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: [],
              primary: "anthropic/claude-opus-4-6", // Empty fallbacks to match working pattern
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error('No credentials found for profile "openai:default".'))
        .mockResolvedValueOnce("config primary worked");

      const result = await runWithModelFallback({
        cfg,
        provider: "openai", // Different provider
        model: "gpt-4.1-mini",
        run,
      });

      // Cross-provider requests should skip configured fallbacks but still try configured primary
      expect(result.result).toBe("config primary worked");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "openai", "gpt-4.1-mini"); // Original request
      expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-opus-4-6"); // Config primary as final fallback
    });

    it("uses fallbacks when session model exactly matches config primary", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Quota exceeded"))
        .mockResolvedValueOnce("fallback worked");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6", // Exact match
        run,
      });

      expect(result.result).toBe("fallback worked");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });
  });

  describe("fallback behavior with provider cooldowns", () => {
    async function makeAuthStoreWithCooldown(
      provider: string,
      reason: "rate_limit" | "overloaded" | "timeout" | "auth" | "billing",
    ): Promise<{ store: AuthProfileStore; dir: string }> {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
      const now = Date.now();
      const store: AuthProfileStore = {
        profiles: {
          [`${provider}:default`]: { key: "test-key", provider, type: "api_key" },
        },
        usageStats: {
          [`${provider}:default`]:
            reason === "rate_limit" || reason === "overloaded" || reason === "timeout"
              ? {
                  cooldownUntil: now + 300_000,
                  failureCounts: { [reason]: 1 },
                }
              : {
                  disabledReason: reason,
                  disabledUntil: now + 300000,
                },
        },
        version: AUTH_STORE_VERSION,
      };
      saveAuthProfileStore(store, tmpDir);
      return { dir: tmpDir, store };
    }

    it("attempts same-provider fallbacks during rate limit cooldown", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "rate_limit");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        agentDir: dir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
    });

    it("attempts same-provider fallbacks during overloaded cooldown", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "overloaded");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        agentDir: dir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
    });

    it("attempts same-provider fallbacks during timeout cooldown", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "timeout");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        agentDir: dir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
    });

    it("skips same-provider models on auth cooldown but still tries no-profile fallback providers", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "auth");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        agentDir: dir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "groq", "llama-3.3-70b-versatile");
    });

    it("skips same-provider models on billing cooldown but still tries no-profile fallback providers", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "billing");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        agentDir: dir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "groq", "llama-3.3-70b-versatile");
    });

    it("tries cross-provider fallbacks when same provider has rate limit", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
      const store: AuthProfileStore = {
        profiles: {
          "anthropic:default": { key: "test-key", provider: "anthropic", type: "api_key" },
          "groq:default": { key: "test-key", provider: "groq", type: "api_key" },
        },
        usageStats: {
          "anthropic:default": {
            cooldownUntil: Date.now() + 300_000,
            failureCounts: { rate_limit: 2 },
          },
        },
        version: AUTH_STORE_VERSION,
      };
      saveAuthProfileStore(store, tmpDir);

      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Still rate limited"))
        .mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        agentDir: tmpDir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });

    it("limits cooldown probes to one per provider before moving to cross-provider fallback", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "rate_limit");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: [
                "anthropic/claude-sonnet-4-5",
                "anthropic/claude-haiku-3-5",
                "groq/llama-3.3-70b-versatile",
              ],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Still rate limited"))
        .mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        agentDir: dir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });

    it("does not consume transient probe slot when first same-provider probe fails with model_not_found", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "rate_limit");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              fallbacks: [
                "anthropic/claude-sonnet-4-5",
                "anthropic/claude-haiku-3-5",
                "groq/llama-3.3-70b-versatile",
              ],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Model not found: anthropic/claude-sonnet-4-5"))
        .mockResolvedValueOnce("haiku success");

      const result = await runWithModelFallback({
        agentDir: dir,
        cfg,
        model: "claude-opus-4-6",
        provider: "anthropic",
        run,
      });

      expect(result.result).toBe("haiku success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
      expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5", {
        allowTransientCooldownProbe: true,
      });
    });
  });
});

describe("runWithImageModelFallback", () => {
  it("keeps explicit image fallbacks reachable when models allowlist is present", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          imageModel: {
            fallbacks: ["google/gemini-2.5-flash-image-preview"],
            primary: "openai/gpt-image-1",
          },
          models: {
            "openai/gpt-image-1": {},
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce("ok");

    const result = await runWithImageModelFallback({
      cfg,
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["openai", "gpt-image-1"],
      ["google", "gemini-2.5-flash-image-preview"],
    ]);
  });
});

describe("isAnthropicBillingError", () => {
  it("does not false-positive on plain 'a 402' prose", () => {
    const samples = [
      "Use a 402 stainless bolt",
      "Book a 402 room",
      "There is a 402 near me",
      "The building at 402 Main Street",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(false);
    }
  });

  it("matches real 402 billing payload contexts including JSON keys", () => {
    const samples = [
      "HTTP 402 Payment Required",
      "status: 402",
      "error code 402",
      '{"status":402,"type":"error"}',
      '{"code":402,"message":"payment required"}',
      '{"error":{"code":402,"message":"billing hard limit reached"}}',
      "got a 402 from the API",
      "returned 402",
      "received a 402 response",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(true);
    }
  });
});
