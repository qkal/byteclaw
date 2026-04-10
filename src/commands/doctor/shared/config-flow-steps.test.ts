import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import { applyLegacyCompatibilityStep, applyUnknownConfigKeyStep } from "./config-flow-steps.js";

describe("doctor config flow steps", () => {
  it("collects legacy compatibility issue lines and preview fix hints", () => {
    const result = applyLegacyCompatibilityStep({
      doctorFixCommand: "openclaw doctor --fix",
      shouldRepair: false,
      snapshot: {
        config: {},
        exists: true,
        issues: [],
        legacyIssues: [{ path: "heartbeat", message: "use agents.defaults.heartbeat" }],
        parsed: { heartbeat: { enabled: true } },
        path: "/tmp/config.json",
        raw: "{}",
        resolved: {},
        runtimeConfig: {},
        sourceConfig: {},
        valid: true,
        warnings: [],
      } satisfies DoctorConfigPreflightResult["snapshot"],
      state: {
        candidate: {},
        cfg: {},
        fixHints: [],
        pendingChanges: false,
      },
    });

    expect(result.issueLines).toEqual([expect.stringContaining("- heartbeat:")]);
    expect(result.changeLines).not.toEqual([]);
    expect(result.state.fixHints).toContain(
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    );
    expect(result.state.pendingChanges).toBe(true);
  });

  it("keeps pending repair state for legacy issues even when the snapshot is already normalized", () => {
    const result = applyLegacyCompatibilityStep({
      doctorFixCommand: "openclaw doctor --fix",
      shouldRepair: false,
      snapshot: {
        config: {},
        exists: true,
        issues: [],
        legacyIssues: [
          {
            path: "talk",
            message: "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
          },
        ],
        parsed: { talk: { modelId: "eleven_v3", voiceId: "voice-1" } },
        path: "/tmp/config.json",
        raw: "{}",
        resolved: {},
        runtimeConfig: {},
        sourceConfig: {},
        valid: true,
        warnings: [],
      } satisfies DoctorConfigPreflightResult["snapshot"],
      state: {
        candidate: {},
        cfg: {},
        fixHints: [],
        pendingChanges: false,
      },
    });

    expect(result.changeLines).toEqual([]);
    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.fixHints).toContain(
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    );
  });

  it("removes unknown keys and adds preview hint", () => {
    const result = applyUnknownConfigKeyStep({
      doctorFixCommand: "openclaw doctor --fix",
      shouldRepair: false,
      state: {
        candidate: { bogus: true } as unknown as OpenClawConfig,
        cfg: {},
        fixHints: [],
        pendingChanges: false,
      },
    });

    expect(result.removed).toEqual(["bogus"]);
    expect(result.state.candidate).toEqual({});
    expect(result.state.fixHints).toContain('Run "openclaw doctor --fix" to remove these keys.');
  });
});
