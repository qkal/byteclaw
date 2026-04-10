import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveHumanDelayConfig } from "./identity.js";

describe("resolveHumanDelayConfig", () => {
  it("returns undefined when no humanDelay config is set", () => {
    const cfg: OpenClawConfig = {};
    expect(resolveHumanDelayConfig(cfg, "main")).toBeUndefined();
  });

  it("merges defaults with per-agent overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          humanDelay: { maxMs: 1800, minMs: 800, mode: "natural" },
        },
        list: [{ humanDelay: { minMs: 400, mode: "custom" }, id: "main" }],
      },
    };

    expect(resolveHumanDelayConfig(cfg, "main")).toEqual({
      maxMs: 1800,
      minMs: 400,
      mode: "custom",
    });
  });
});
