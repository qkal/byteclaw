import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveFastModeState } from "./fast-mode.js";

describe("resolveFastModeState", () => {
  it("prefers session overrides", () => {
    const state = resolveFastModeState({
      cfg: {} as OpenClawConfig,
      model: "gpt-4o",
      provider: "openai",
      sessionEntry: { fastMode: true },
    });

    expect(state.enabled).toBe(true);
    expect(state.source).toBe("session");
  });

  it("uses agent fastModeDefault when present", () => {
    const cfg = {
      agents: {
        list: [{ fastModeDefault: true, id: "alpha" }],
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      agentId: "alpha",
      cfg,
      model: "gpt-4o",
      provider: "openai",
    });

    expect(state.enabled).toBe(true);
    expect(state.source).toBe("agent");
  });

  it("falls back to model config when agent default is absent", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o": { params: { fastMode: true } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      model: "gpt-4o",
      provider: "openai",
    });

    expect(state.enabled).toBe(true);
    expect(state.source).toBe("config");
  });

  it("defaults to off when unset", () => {
    const state = resolveFastModeState({
      cfg: {} as OpenClawConfig,
      model: "gpt-4o",
      provider: "openai",
    });

    expect(state.enabled).toBe(false);
    expect(state.source).toBe("default");
  });
});
