import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
} from "./subagent-spawn-plan.js";

function createConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    ...overrides,
  } as OpenClawConfig;
}

describe("subagent spawn model + thinking plan", () => {
  it("includes explicit model overrides in the initial patch", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      modelOverride: "claude-haiku-4-5",
      targetAgentId: "research",
    });
    expect(plan).toMatchObject({
      initialSessionPatch: {
        model: "claude-haiku-4-5",
      },
      modelApplied: true,
      resolvedModel: "claude-haiku-4-5",
      status: "ok",
    });
  });

  it("normalizes thinking overrides into the initial patch", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
      thinkingOverrideRaw: "high",
    });
    expect(plan).toMatchObject({
      initialSessionPatch: {
        thinkingLevel: "high",
      },
      status: "ok",
      thinkingOverride: "high",
    });
  });

  it("rejects invalid thinking levels before any runtime work", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
      thinkingOverrideRaw: "banana",
    });
    expect(plan).toMatchObject({
      status: "error",
    });
    if (plan.status === "error") {
      expect(plan.error).toMatch(/Invalid thinking level/i);
    }
  });

  it("applies default subagent model from defaults config", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig({
        agents: { defaults: { subagents: { model: "minimax/MiniMax-M2.7" } } },
      }),
      targetAgentId: "research",
    });
    expect(plan).toMatchObject({
      initialSessionPatch: { model: "minimax/MiniMax-M2.7" },
      resolvedModel: "minimax/MiniMax-M2.7",
      status: "ok",
    });
  });

  it("falls back to runtime default model when no model config is set", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
    });
    expect(plan).toMatchObject({
      initialSessionPatch: { model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}` },
      resolvedModel: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      status: "ok",
    });
  });

  it("prefers per-agent subagent model over defaults", () => {
    const cfg = createConfig({
      agents: {
        defaults: { subagents: { model: "minimax/MiniMax-M2.7" } },
        list: [{ id: "research", subagents: { model: "opencode/claude" } }],
      },
    });
    const targetAgentConfig = {
      id: "research",
      subagents: { model: "opencode/claude" },
    };
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentConfig,
      targetAgentId: "research",
    });
    expect(plan).toMatchObject({
      initialSessionPatch: { model: "opencode/claude" },
      resolvedModel: "opencode/claude",
      status: "ok",
    });
  });

  it("prefers target agent primary model over global default", () => {
    const cfg = createConfig({
      agents: {
        defaults: { model: { primary: "minimax/MiniMax-M2.7" } },
        list: [{ id: "research", model: { primary: "opencode/claude" } }],
      },
    });
    const targetAgentConfig = {
      id: "research",
      model: { primary: "opencode/claude" },
    };
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentConfig,
      targetAgentId: "research",
    });
    expect(plan).toMatchObject({
      initialSessionPatch: { model: "opencode/claude" },
      resolvedModel: "opencode/claude",
      status: "ok",
    });
  });

  it("uses config default timeout when agent omits runTimeoutSeconds", () => {
    expect(
      resolveConfiguredSubagentRunTimeoutSeconds({
        cfg: createConfig({
          agents: { defaults: { subagents: { runTimeoutSeconds: 120 } } },
        }),
      }),
    ).toBe(120);
  });

  it("explicit runTimeoutSeconds wins over config default", () => {
    expect(
      resolveConfiguredSubagentRunTimeoutSeconds({
        cfg: createConfig({
          agents: { defaults: { subagents: { runTimeoutSeconds: 120 } } },
        }),
        runTimeoutSeconds: 2,
      }),
    ).toBe(2);
  });
});
