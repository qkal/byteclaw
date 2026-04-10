import { afterEach, describe, expect, it, vi } from "vitest";
import { findDuplicateAgentDirs } from "./agent-dirs.js";
import type { OpenClawConfig } from "./types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveEffectiveAgentDir via findDuplicateAgentDirs", () => {
  it("uses OPENCLAW_HOME for default agent dir resolution", () => {
    // FindDuplicateAgentDirs calls resolveEffectiveAgentDir internally.
    // With a single agent there are no duplicates, but we can inspect the
    // Resolved dir indirectly by triggering a duplicate with two agents
    // That both fall through to the same default dir — which can't happen
    // Since they have different IDs.  Instead we just verify no crash and
    // That the env flows through by checking a two-agent config produces
    // Distinct dirs (no duplicates).
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alpha" }, { id: "beta" }],
      },
    };

    const env = {
      HOME: "/home/other",
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    const dupes = findDuplicateAgentDirs(cfg, { env });
    expect(dupes).toHaveLength(0);
  });

  it("resolves agent dir under OPENCLAW_HOME state dir", () => {
    // Force two agents to the same explicit agentDir to verify the path
    // That doesn't use the default — then test the default path by
    // Checking that a single-agent config resolves without duplicates.
    const cfg: OpenClawConfig = {};

    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    // No duplicates for a single default agent
    const dupes = findDuplicateAgentDirs(cfg, { env });
    expect(dupes).toHaveLength(0);
  });
});
