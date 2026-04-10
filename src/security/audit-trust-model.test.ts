import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
} from "./audit-extra.sync.js";

function audit(cfg: OpenClawConfig) {
  return [...collectExposureMatrixFindings(cfg), ...collectLikelyMultiUserSetupFindings(cfg)];
}

describe("security audit trust model findings", () => {
  it("evaluates trust-model exposure findings", async () => {
    const cases = [
      {
        assert: () => {
          const findings = audit(cases[0].cfg);
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_elevated" &&
                finding.severity === "critical",
            ),
          ).toBe(true);
        },
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { allowFrom: { whatsapp: ["+1"] }, enabled: true } },
        } satisfies OpenClawConfig,
        name: "flags open groupPolicy when tools.elevated is enabled",
      },
      {
        assert: () => {
          const findings = audit(cases[1].cfg);
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_runtime_or_fs" &&
                finding.severity === "critical",
            ),
          ).toBe(true);
        },
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        name: "flags open groupPolicy when runtime/filesystem tools are exposed without guards",
      },
      {
        assert: () => {
          const findings = audit(cases[2].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.exposure.open_groups_with_runtime_or_fs",
            ),
          ).toBe(false);
        },
        cfg: {
          agents: {
            defaults: {
              sandbox: { mode: "all" },
            },
          },
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
          },
        } satisfies OpenClawConfig,
        name: "does not flag runtime/filesystem exposure for open groups when sandbox mode is all",
      },
      {
        assert: () => {
          const findings = audit(cases[3].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.exposure.open_groups_with_runtime_or_fs",
            ),
          ).toBe(false);
        },
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            deny: ["group:runtime"],
            elevated: { enabled: false },
            fs: { workspaceOnly: true },
            profile: "coding",
          },
        } satisfies OpenClawConfig,
        name: "does not flag runtime/filesystem exposure for open groups when runtime is denied and fs is workspace-only",
      },
      {
        assert: () => {
          const findings = audit(cases[4].cfg);
          const finding = findings.find(
            (entry) => entry.checkId === "security.trust_model.multi_user_heuristic",
          );
          expect(finding?.severity).toBe("warn");
          expect(finding?.detail).toContain(
            'channels.discord.groupPolicy="allowlist" with configured group targets',
          );
          expect(finding?.detail).toContain("personal-assistant");
          expect(finding?.remediation).toContain('agents.defaults.sandbox.mode="all"');
        },
        cfg: {
          channels: {
            discord: {
              groupPolicy: "allowlist",
              guilds: {
                "1234567890": {
                  channels: {
                    "7777777777": { enabled: true },
                  },
                },
              },
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        name: "warns when config heuristics suggest a likely multi-user setup",
      },
      {
        assert: () => {
          const findings = audit(cases[5].cfg);
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(false);
        },
        cfg: {
          channels: {
            discord: {
              groupPolicy: "allowlist",
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        name: "does not warn for multi-user heuristic when no shared-user signals are configured",
      },
    ] as const;

    for (const testCase of cases) {
      testCase.assert();
    }
  });
});
