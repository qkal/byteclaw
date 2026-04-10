import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const SUBAGENT_MODEL = "synthetic/hf:moonshotai/Kimi-K2.5";
const KIMI_SUBAGENT_KEY = "agent:kimi:subagent:child";
const MAIN_SESSION_KEY = "agent:main:main";
const EMPTY_CFG = {} as OpenClawConfig;

type ApplySessionsPatchArgs = Parameters<typeof applySessionsPatchToStore>[0];

async function runPatch(params: {
  patch: ApplySessionsPatchArgs["patch"];
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  storeKey?: string;
  loadGatewayModelCatalog?: ApplySessionsPatchArgs["loadGatewayModelCatalog"];
}) {
  return applySessionsPatchToStore({
    cfg: params.cfg ?? EMPTY_CFG,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
    patch: params.patch,
    store: params.store ?? {},
    storeKey: params.storeKey ?? MAIN_SESSION_KEY,
  });
}

function expectPatchOk(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
): SessionEntry {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

function expectPatchError(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
  message: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected patch failure containing: ${message}`);
  }
  expect(result.error.message).toContain(message);
}

async function applySubagentModelPatch(cfg: OpenClawConfig) {
  return expectPatchOk(
    await runPatch({
      cfg,
      loadGatewayModelCatalog: async () => [
        { id: "claude-sonnet-4-6", name: "sonnet", provider: "anthropic" },
        { id: "hf:moonshotai/Kimi-K2.5", name: "kimi", provider: "synthetic" },
      ],
      patch: {
        key: KIMI_SUBAGENT_KEY,
        model: SUBAGENT_MODEL,
      },
      storeKey: KIMI_SUBAGENT_KEY,
    }),
  );
}

function makeKimiSubagentCfg(params: {
  agentPrimaryModel?: string;
  agentSubagentModel?: string;
  defaultsSubagentModel?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "default" },
        },
        subagents: params.defaultsSubagentModel
          ? { model: params.defaultsSubagentModel }
          : undefined,
      },
      list: [
        {
          id: "kimi",
          model: params.agentPrimaryModel ? { primary: params.agentPrimaryModel } : undefined,
          subagents: params.agentSubagentModel ? { model: params.agentSubagentModel } : undefined,
        },
      ],
    },
  } as OpenClawConfig;
}

function createAllowlistedAnthropicModelCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
        },
      },
    },
  } as OpenClawConfig;
}

describe("gateway sessions patch", () => {
  test("persists thinkingLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: "off" },
      }),
    );
    expect(entry.thinkingLevel).toBe("off");
  });

  test("clears thinkingLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { thinkingLevel: "low" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: null },
        store,
      }),
    );
    expect(entry.thinkingLevel).toBeUndefined();
  });

  test("persists reasoningLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: "off" },
      }),
    );
    expect(entry.reasoningLevel).toBe("off");
  });

  test("clears reasoningLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { reasoningLevel: "stream" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: null },
        store,
      }),
    );
    expect(entry.reasoningLevel).toBeUndefined();
  });

  test("persists fastMode=false (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { fastMode: false, key: MAIN_SESSION_KEY },
      }),
    );
    expect(entry.fastMode).toBe(false);
  });

  test("persists fastMode=true", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { fastMode: true, key: MAIN_SESSION_KEY },
      }),
    );
    expect(entry.fastMode).toBe(true);
  });

  test("clears fastMode when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { fastMode: true } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        patch: { fastMode: null, key: MAIN_SESSION_KEY },
        store,
      }),
    );
    expect(entry.fastMode).toBeUndefined();
  });

  test("persists elevatedLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { elevatedLevel: "off", key: MAIN_SESSION_KEY },
      }),
    );
    expect(entry.elevatedLevel).toBe("off");
  });

  test("persists elevatedLevel=on", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { elevatedLevel: "on", key: MAIN_SESSION_KEY },
      }),
    );
    expect(entry.elevatedLevel).toBe("on");
  });

  test("clears elevatedLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { elevatedLevel: "off" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        patch: { elevatedLevel: null, key: MAIN_SESSION_KEY },
        store,
      }),
    );
    expect(entry.elevatedLevel).toBeUndefined();
  });

  test("rejects invalid elevatedLevel values", async () => {
    const result = await runPatch({
      patch: { elevatedLevel: "maybe", key: MAIN_SESSION_KEY },
    });
    expectPatchError(result, "invalid elevatedLevel");
  });

  test("clears auth overrides when model patch changes", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        authProfileOverride: "anthropic:default",
        authProfileOverrideCompactionCount: 3,
        authProfileOverrideSource: "user",
        modelOverride: "claude-opus-4-6",
        providerOverride: "anthropic",
        sessionId: "sess",
        updatedAt: 1,
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        loadGatewayModelCatalog: async () => [
          { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", provider: "anthropic" },
        ],
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        store,
      }),
    );
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("marks explicit model patches as pending live model switches", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        modelOverride: "gpt-5.4",
        providerOverride: "openai",
        sessionId: "sess-live",
        updatedAt: 1,
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: createAllowlistedAnthropicModelCfg(),
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "gpt-5.4", provider: "openai" },
          { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", provider: "anthropic" },
        ],
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        store,
      }),
    );

    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test("marks model reset patches as pending live model switches", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        modelOverride: "claude-sonnet-4-6",
        providerOverride: "anthropic",
        sessionId: "sess-live-reset",
        updatedAt: 1,
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: null },
        store,
      }),
    );

    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test.each([
    {
      catalog: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5", provider: "anthropic" },
      ],
      name: "accepts explicit allowlisted provider/model refs from sessions.patch",
    },
    {
      catalog: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "gpt-5.4", name: "GPT-5.2", provider: "openai" },
      ],
      name: "accepts explicit allowlisted refs absent from bundled catalog",
    },
  ])("$name", async ({ catalog }) => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: createAllowlistedAnthropicModelCfg(),
        loadGatewayModelCatalog: async () => catalog,
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
      }),
    );
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
  });

  test("sets spawnDepth for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: "agent:main:subagent:child", spawnDepth: 2 },
        storeKey: "agent:main:subagent:child",
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("sets spawnedBy for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: {
          key: "agent:main:acp:child",
          spawnedBy: "agent:main:main",
        },
        storeKey: "agent:main:acp:child",
      }),
    );
    expect(entry.spawnedBy).toBe("agent:main:main");
  });

  test("sets spawnedWorkspaceDir for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: {
          key: "agent:main:subagent:child",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
        },
        storeKey: "agent:main:subagent:child",
      }),
    );
    expect(entry.spawnedWorkspaceDir).toBe("/tmp/subagent-workspace");
  });

  test("sets spawnDepth for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: "agent:main:acp:child", spawnDepth: 2 },
        storeKey: "agent:main:acp:child",
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("rejects spawnDepth on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnDepth: 1 },
    });
    expectPatchError(result, "spawnDepth is only supported");
  });

  test("rejects spawnedWorkspaceDir on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnedWorkspaceDir: "/tmp/nope" },
    });
    expectPatchError(result, "spawnedWorkspaceDir is only supported");
  });

  test("normalizes exec/send/group patches", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: {
          execAsk: " ON-MISS ",
          execHost: " AUTO ",
          execNode: " worker-1 ",
          execSecurity: " ALLOWLIST ",
          groupActivation: "Always" as unknown as "mention",
          key: MAIN_SESSION_KEY,
          sendPolicy: "DENY" as unknown as "allow",
        },
      }),
    );
    expect(entry.execHost).toBe("auto");
    expect(entry.execSecurity).toBe("allowlist");
    expect(entry.execAsk).toBe("on-miss");
    expect(entry.execNode).toBe("worker-1");
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.groupActivation).toBe("always");
  });

  test("rejects invalid execHost values", async () => {
    const result = await runPatch({
      patch: { execHost: "edge", key: MAIN_SESSION_KEY },
    });
    expectPatchError(result, "invalid execHost");
  });

  test("rejects invalid sendPolicy values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, sendPolicy: "ask" as unknown as "allow" },
    });
    expectPatchError(result, "invalid sendPolicy");
  });

  test("rejects invalid groupActivation values", async () => {
    const result = await runPatch({
      patch: { groupActivation: "never" as unknown as "mention", key: MAIN_SESSION_KEY },
    });
    expectPatchError(result, "invalid groupActivation");
  });

  test("allows target agent own model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "synthetic/hf:moonshotai/Kimi-K2.5",
    });

    const entry = await applySubagentModelPatch(cfg);
    // Selected model matches the target agent default, so no override is stored.
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
  });

  test("allows target agent subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "anthropic/claude-sonnet-4-6",
      agentSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });

  test("allows global defaults.subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      defaultsSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });
});
