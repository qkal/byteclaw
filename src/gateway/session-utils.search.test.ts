import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { listSessionsFromStore } from "./session-utils.js";

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, Record<string, never>>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

function createLegacyRuntimeListConfig(
  models?: Record<string, Record<string, never>>,
): OpenClawConfig {
  return createModelDefaultsConfig({
    primary: "google-gemini-cli/gemini-3-pro-preview",
    ...(models ? { models } : {}),
  });
}

function createLegacyRuntimeStore(model: string): Record<string, SessionEntry> {
  return {
    "agent:main:main": {
      model,
      sessionId: "sess-main",
      updatedAt: Date.now(),
    } as SessionEntry,
  };
}

describe("listSessionsFromStore search", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  const baseCfg = {
    agents: { list: [{ default: true, id: "main" }] },
    session: { mainKey: "main" },
  } as OpenClawConfig;

  const makeStore = (): Record<string, SessionEntry> => ({
    "agent:main:discord:group:dev-team": {
      label: "discord",
      sessionId: "sess-discord-1",
      subject: "Dev Team Discussion",
      updatedAt: Date.now() - 2000,
    } as SessionEntry,
    "agent:main:personal-chat": {
      displayName: "Personal Chat",
      sessionId: "sess-personal-1",
      subject: "Family Reunion Planning",
      updatedAt: Date.now() - 1000,
    } as SessionEntry,
    "agent:main:work-project": {
      displayName: "Work Project Alpha",
      label: "work",
      sessionId: "sess-work-1",
      updatedAt: Date.now(),
    } as SessionEntry,
  });

  test("returns all sessions when search is empty or missing", () => {
    const cases = [{ opts: { search: "" } }, { opts: {} }] as const;
    for (const testCase of cases) {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        opts: testCase.opts,
        store: makeStore(),
        storePath: "/tmp/sessions.json",
      });
      expect(result.sessions).toHaveLength(3);
    }
  });

  test("filters sessions across display metadata and key fields", () => {
    const cases = [
      { expectedKey: "agent:main:work-project", search: "WORK PROJECT" },
      { expectedKey: "agent:main:personal-chat", search: "reunion" },
      { expectedKey: "agent:main:discord:group:dev-team", search: "discord" },
      { expectedKey: "agent:main:personal-chat", search: "sess-personal" },
      { expectedKey: "agent:main:discord:group:dev-team", search: "dev-team" },
      { expectedKey: "agent:main:work-project", search: "alpha" },
      { expectedKey: "agent:main:personal-chat", search: "  personal  " },
      { expectedKey: undefined, search: "nonexistent-term" },
    ] as const;

    for (const testCase of cases) {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        opts: { search: testCase.search },
        store: makeStore(),
        storePath: "/tmp/sessions.json",
      });
      if (!testCase.expectedKey) {
        expect(result.sessions).toHaveLength(0);
        continue;
      }
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].key).toBe(testCase.expectedKey);
    }
  });

  test("hides cron run alias session keys from sessions list", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job-1": {
        label: "Cron: job-1",
        sessionId: "run-abc",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:cron:job-1:run:run-abc": {
        label: "Cron: job-1",
        sessionId: "run-abc",
        updatedAt: now,
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg: baseCfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:cron:job-1"]);
  });

  test.each([
    {
      cfg: createLegacyRuntimeListConfig(),
      expectedProvider: undefined,
      name: "does not guess provider for legacy runtime model without modelProvider",
      runtimeModel: "claude-sonnet-4-6",
    },
    {
      cfg: createLegacyRuntimeListConfig({ "anthropic/claude-sonnet-4-6": {} }),
      expectedProvider: "anthropic",
      name: "infers provider for legacy runtime model when allowlist match is unique",
      runtimeModel: "claude-sonnet-4-6",
    },
    {
      cfg: createLegacyRuntimeListConfig({
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      }),
      expectedProvider: "vercel-ai-gateway",
      name: "infers wrapper provider for slash-prefixed legacy runtime model when allowlist match is unique",
      runtimeModel: "anthropic/claude-sonnet-4-6",
    },
  ])("$name", ({ cfg, runtimeModel, expectedProvider }) => {
    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store: createLegacyRuntimeStore(runtimeModel),
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions[0]?.modelProvider).toBe(expectedProvider);
    expect(result.sessions[0]?.model).toBe(runtimeModel);
  });

  test("exposes unknown totals when freshness is stale or missing", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:fresh": {
        sessionId: "sess-fresh",
        totalTokens: 1200,
        totalTokensFresh: true,
        updatedAt: now,
      } as SessionEntry,
      "agent:main:missing": {
        inputTokens: 100,
        outputTokens: 200,
        sessionId: "sess-missing",
        updatedAt: now - 2000,
      } as SessionEntry,
      "agent:main:stale": {
        sessionId: "sess-stale",
        totalTokens: 2200,
        totalTokensFresh: false,
        updatedAt: now - 1000,
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg: baseCfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const fresh = result.sessions.find((row) => row.key === "agent:main:fresh");
    const stale = result.sessions.find((row) => row.key === "agent:main:stale");
    const missing = result.sessions.find((row) => row.key === "agent:main:missing");
    expect(fresh?.totalTokens).toBe(1200);
    expect(fresh?.totalTokensFresh).toBe(true);
    expect(stale?.totalTokens).toBeUndefined();
    expect(stale?.totalTokensFresh).toBe(false);
    expect(missing?.totalTokens).toBeUndefined();
    expect(missing?.totalTokensFresh).toBe(false);
  });

  test("includes estimated session cost when model pricing is configured", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "main" }] },
      models: {
        providers: {
          openai: {
            models: [
              {
                baseUrl: "https://api.openai.com/v1",
                cost: { cacheRead: 0.125, cacheWrite: 0.5, input: 1.25, output: 10 },
                id: "gpt-5.4",
                label: "GPT 5.4",
              },
            ],
          },
        },
      },
      session: { mainKey: "main" },
    } as unknown as OpenClawConfig;
    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store: {
        "agent:main:main": {
          cacheRead: 1_000,
          cacheWrite: 200,
          inputTokens: 2_000,
          model: "gpt-5.4",
          modelProvider: "openai",
          outputTokens: 500,
          sessionId: "sess-main",
          updatedAt: Date.now(),
        } as SessionEntry,
      },
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007_725, 8);
  });

  test("prefers persisted estimated session cost from the store", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-store-cost-"));
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ id: "sess-main", type: "session", version: 1 }),
        JSON.stringify({
          message: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
            usage: {
              cacheRead: 1200,
              cost: { total: 0.007_725 },
              input: 2000,
              output: 500,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        opts: {},
        store: {
          "agent:main:main": {
            estimatedCostUsd: 0.1234,
            model: "claude-sonnet-4-6",
            modelProvider: "anthropic",
            sessionId: "sess-main",
            totalTokens: 0,
            totalTokensFresh: false,
            updatedAt: Date.now(),
          } as SessionEntry,
        },
        storePath,
      });

      expect(result.sessions[0]?.estimatedCostUsd).toBe(0.1234);
      expect(result.sessions[0]?.totalTokens).toBe(3200);
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("keeps zero estimated session cost when configured model pricing resolves to free", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "main" }] },
      models: {
        providers: {
          "openai-codex": {
            models: [
              {
                baseUrl: "https://api.openai.com/v1",
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "gpt-5.3-codex-spark",
                label: "GPT 5.3 Codex Spark",
              },
            ],
          },
        },
      },
      session: { mainKey: "main" },
    } as unknown as OpenClawConfig;
    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store: {
        "agent:main:main": {
          cacheRead: 1_536,
          cacheWrite: 0,
          inputTokens: 5_107,
          model: "gpt-5.3-codex-spark",
          modelProvider: "openai-codex",
          outputTokens: 1_827,
          sessionId: "sess-main",
          updatedAt: Date.now(),
        } as SessionEntry,
      },
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions[0]?.estimatedCostUsd).toBe(0);
  });

  test("falls back to transcript usage for totalTokens and zero estimatedCostUsd", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-zero-cost-"));
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ id: "sess-main", type: "session", version: 1 }),
        JSON.stringify({
          message: {
            model: "gpt-5.3-codex-spark",
            provider: "openai-codex",
            role: "assistant",
            usage: {
              cacheRead: 1536,
              cost: { total: 0 },
              input: 5107,
              output: 1827,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        opts: {},
        store: {
          "agent:main:main": {
            cacheRead: 0,
            cacheWrite: 0,
            inputTokens: 0,
            model: "gpt-5.3-codex-spark",
            modelProvider: "openai-codex",
            outputTokens: 0,
            sessionId: "sess-main",
            totalTokens: 0,
            totalTokensFresh: false,
            updatedAt: Date.now(),
          } as SessionEntry,
        },
        storePath,
      });

      expect(result.sessions[0]?.totalTokens).toBe(6643);
      expect(result.sessions[0]?.totalTokensFresh).toBe(true);
      expect(result.sessions[0]?.estimatedCostUsd).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("falls back to transcript usage for totalTokens and estimatedCostUsd, and derives contextTokens from the resolved model", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
        list: [{ default: true, id: "main" }],
      },
      session: { mainKey: "main" },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ id: "sess-main", type: "session", version: 1 }),
        JSON.stringify({
          message: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
            usage: {
              cacheRead: 1200,
              cost: { total: 0.007_725 },
              input: 2000,
              output: 500,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      const result = listSessionsFromStore({
        cfg,
        opts: {},
        store: {
          "agent:main:main": {
            cacheRead: 0,
            cacheWrite: 0,
            inputTokens: 0,
            model: "claude-sonnet-4-6",
            modelProvider: "anthropic",
            outputTokens: 0,
            sessionId: "sess-main",
            totalTokens: 0,
            totalTokensFresh: false,
            updatedAt: Date.now(),
          } as SessionEntry,
        },
        storePath,
      });

      expect(result.sessions[0]?.totalTokens).toBe(3200);
      expect(result.sessions[0]?.totalTokensFresh).toBe(true);
      expect(result.sessions[0]?.contextTokens).toBe(1_048_576);
      expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007_725, 8);
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("uses subagent run model immediately for child sessions while transcript usage fills live totals", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
        list: [{ default: true, id: "main" }],
      },
      session: { mainKey: "main" },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-child.jsonl"),
      [
        JSON.stringify({ id: "sess-child", type: "session", version: 1 }),
        JSON.stringify({
          message: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
            usage: {
              cacheRead: 1200,
              cost: { total: 0.007_725 },
              input: 2000,
              output: 500,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:child-live",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 5000,
      model: "anthropic/claude-sonnet-4-6",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-child-live",
      startedAt: now - 4000,
      task: "child task",
    });

    try {
      const result = listSessionsFromStore({
        cfg,
        opts: {},
        store: {
          "agent:main:subagent:child-live": {
            sessionId: "sess-child",
            spawnedBy: "agent:main:main",
            totalTokens: 0,
            totalTokensFresh: false,
            updatedAt: now,
          } as SessionEntry,
        },
        storePath,
      });

      expect(result.sessions[0]).toMatchObject({
        contextTokens: 1_048_576,
        key: "agent:main:subagent:child-live",
        model: "claude-sonnet-4-6",
        modelProvider: "anthropic",
        status: "running",
        totalTokens: 3200,
        totalTokensFresh: true,
      });
      expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007_725, 8);
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("keeps a running subagent model when transcript fallback still reflects an older run", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-subagent-stale-model-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
        list: [{ default: true, id: "main" }],
      },
      session: { mainKey: "main" },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-child-stale.jsonl"),
      [
        JSON.stringify({ id: "sess-child-stale", type: "session", version: 1 }),
        JSON.stringify({
          message: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
            usage: {
              cacheRead: 1200,
              cost: { total: 0.007_725 },
              input: 2000,
              output: 500,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:child-live-stale-transcript",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 5000,
      model: "openai/gpt-5.4",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-child-live-new-model",
      startedAt: now - 4000,
      task: "child task",
    });

    try {
      const result = listSessionsFromStore({
        cfg,
        opts: {},
        store: {
          "agent:main:subagent:child-live-stale-transcript": {
            sessionId: "sess-child-stale",
            spawnedBy: "agent:main:main",
            totalTokens: 0,
            totalTokensFresh: false,
            updatedAt: now,
          } as SessionEntry,
        },
        storePath,
      });

      expect(result.sessions[0]).toMatchObject({
        key: "agent:main:subagent:child-live-stale-transcript",
        model: "gpt-5.4",
        modelProvider: "openai",
        status: "running",
        totalTokens: 3200,
        totalTokensFresh: true,
      });
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("keeps the selected override model when runtime identity was intentionally cleared", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-cleared-runtime-model-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
        list: [{ default: true, id: "main" }],
      },
      session: { mainKey: "main" },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-override.jsonl"),
      [
        JSON.stringify({ id: "sess-override", type: "session", version: 1 }),
        JSON.stringify({
          message: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
            usage: {
              cacheRead: 1200,
              cost: { total: 0.007_725 },
              input: 2000,
              output: 500,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      const result = listSessionsFromStore({
        cfg,
        opts: {},
        store: {
          "agent:main:main": {
            modelOverride: "gpt-5.4",
            providerOverride: "openai",
            sessionId: "sess-override",
            totalTokens: 0,
            totalTokensFresh: false,
            updatedAt: now,
          } as SessionEntry,
        },
        storePath,
      });

      expect(result.sessions[0]).toMatchObject({
        key: "agent:main:main",
        model: "gpt-5.4",
        modelProvider: "openai",
        totalTokens: 3200,
        totalTokensFresh: true,
      });
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("does not replace the current runtime model when transcript fallback is only for missing pricing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-pricing-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      agents: {
        list: [{ default: true, id: "main" }],
      },
      session: { mainKey: "main" },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-pricing.jsonl"),
      [
        JSON.stringify({ id: "sess-pricing", type: "session", version: 1 }),
        JSON.stringify({
          message: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
            usage: {
              cacheRead: 1200,
              cost: { total: 0.007_725 },
              input: 2000,
              output: 500,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      const result = listSessionsFromStore({
        cfg,
        opts: {},
        store: {
          "agent:main:main": {
            cacheRead: 1_200,
            contextTokens: 200_000,
            inputTokens: 2_000,
            model: "gpt-5.4",
            modelProvider: "openai",
            outputTokens: 500,
            sessionId: "sess-pricing",
            totalTokens: 3_200,
            totalTokensFresh: true,
            updatedAt: now,
          } as SessionEntry,
        },
        storePath,
      });

      expect(result.sessions[0]).toMatchObject({
        contextTokens: 200_000,
        key: "agent:main:main",
        model: "gpt-5.4",
        modelProvider: "openai",
        totalTokens: 3200,
        totalTokensFresh: true,
      });
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
