import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  OPENCODE_ZEN_DEFAULT_MODEL,
  applyOpencodeZenModelDefault,
} from "../plugin-sdk/opencode.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";

function makePrompter(): WizardPrompter {
  return {
    confirm: async () => false,
    intro: async () => {},
    multiselect: (async <T>() => [] as T[]) as WizardPrompter["multiselect"],
    note: async () => {},
    outro: async () => {},
    progress: () => ({ stop: () => {}, update: () => {} }),
    select: (async <T>() => "" as T) as WizardPrompter["select"],
    text: async () => "",
  };
}

function expectPrimaryModelChanged(
  applied: { changed: boolean; next: OpenClawConfig },
  primary: string,
) {
  expect(applied.changed).toBe(true);
  expect(applied.next.agents?.defaults?.model).toEqual({ primary });
}

function expectConfigUnchanged(
  applied: { changed: boolean; next: OpenClawConfig },
  cfg: OpenClawConfig,
) {
  expect(applied.changed).toBe(false);
  expect(applied.next).toEqual(cfg);
}

describe("applyDefaultModelChoice", () => {
  it("ensures allowlist entry exists when returning an agent override", async () => {
    const defaultModel = "vercel-ai-gateway/anthropic/claude-opus-4.6";
    const noteAgentModel = vi.fn(async () => {});
    const applied = await applyDefaultModelChoice({
      config: {},
      setDefaultModel: false,
      defaultModel,
      // Simulate a provider function that does not explicitly add the entry.
      applyProviderConfig: (config: OpenClawConfig) => config,
      applyDefaultConfig: (config: OpenClawConfig) => config,
      noteAgentModel,
      prompter: makePrompter(),
    });

    expect(noteAgentModel).toHaveBeenCalledWith(defaultModel);
    expect(applied.agentModelOverride).toBe(defaultModel);
    expect(applied.config.agents?.defaults?.models?.[defaultModel]).toEqual({});
  });

  it("adds canonical allowlist key for anthropic aliases", async () => {
    const defaultModel = "anthropic/opus-4.6";
    const applied = await applyDefaultModelChoice({
      applyDefaultConfig: (config: OpenClawConfig) => config,
      applyProviderConfig: (config: OpenClawConfig) => config,
      config: {},
      defaultModel,
      noteAgentModel: async () => {},
      prompter: makePrompter(),
      setDefaultModel: false,
    });

    expect(applied.config.agents?.defaults?.models?.[defaultModel]).toEqual({});
    expect(applied.config.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]).toEqual({});
  });

  it("uses applyDefaultConfig path when setDefaultModel is true", async () => {
    const defaultModel = "openai/gpt-5.4";
    const applied = await applyDefaultModelChoice({
      applyDefaultConfig: () => ({
        agents: {
          defaults: {
            model: { primary: defaultModel },
          },
        },
      }),
      applyProviderConfig: (config: OpenClawConfig) => config,
      config: {},
      defaultModel,
      noteAgentModel: async () => {},
      noteDefault: defaultModel,
      prompter: makePrompter(),
      setDefaultModel: true,
    });

    expect(applied.agentModelOverride).toBeUndefined();
    expect(applied.config.agents?.defaults?.model).toEqual({ primary: defaultModel });
  });
});

describe("applyOpencodeZenModelDefault", () => {
  it("sets defaults when model is unset", () => {
    const cfg: OpenClawConfig = { agents: { defaults: {} } };
    const applied = applyOpencodeZenModelDefault(cfg);
    expectPrimaryModelChanged(applied, OPENCODE_ZEN_DEFAULT_MODEL);
  });

  it("overrides existing models", () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
    } as OpenClawConfig;
    const applied = applyOpencodeZenModelDefault(cfg);
    expectPrimaryModelChanged(applied, OPENCODE_ZEN_DEFAULT_MODEL);
  });

  it("no-ops when already legacy opencode-zen default", () => {
    const cfg = {
      agents: { defaults: { model: "opencode-zen/claude-opus-4-5" } },
    } as OpenClawConfig;
    const applied = applyOpencodeZenModelDefault(cfg);
    expectConfigUnchanged(applied, cfg);
  });

  it("preserves fallbacks when setting primary", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["google/gemini-3-pro"],
            primary: "anthropic/claude-opus-4-6",
          },
        },
      },
    };
    const applied = applyOpencodeZenModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      fallbacks: ["google/gemini-3-pro"],
      primary: OPENCODE_ZEN_DEFAULT_MODEL,
    });
  });

  it("no-ops when already on the current default", () => {
    const cfg = {
      agents: { defaults: { model: OPENCODE_ZEN_DEFAULT_MODEL } },
    } as OpenClawConfig;
    const applied = applyOpencodeZenModelDefault(cfg);
    expectConfigUnchanged(applied, cfg);
  });
});
