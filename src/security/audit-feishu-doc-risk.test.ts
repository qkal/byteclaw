import { describe, expect, it } from "vitest";
import { collectFeishuSecurityAuditFindings } from "../../test/helpers/channels/security-audit-contract.js";
import type { OpenClawConfig } from "../config/config.js";

describe("security audit Feishu doc risk findings", () => {
  it.each([
    {
      cfg: {
        channels: {
          feishu: {
            appId: "cli_test",
            appSecret: "secret_test",
          },
        },
      } satisfies OpenClawConfig,
      expectedFinding: "channels.feishu.doc_owner_open_id",
      name: "warns when Feishu doc tool is enabled because create can grant requester access",
    },
    {
      cfg: {
        channels: {
          feishu: {
            appId: "cli_test",
            appSecret: {
              id: "FEISHU_APP_SECRET",
              provider: "default",
              source: "env",
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedFinding: "channels.feishu.doc_owner_open_id",
      name: "treats Feishu SecretRef appSecret as configured for doc tool risk detection",
    },
    {
      cfg: {
        channels: {
          feishu: {
            appId: "cli_test",
            appSecret: "secret_test",
            tools: { doc: false },
          },
        },
      } satisfies OpenClawConfig,
      expectedNoFinding: "channels.feishu.doc_owner_open_id",
      name: "does not warn for Feishu doc grant risk when doc tools are disabled",
    },
  ])("$name", ({ cfg, expectedFinding, expectedNoFinding }) => {
    const findings = collectFeishuSecurityAuditFindings({ cfg });
    if (expectedFinding) {
      expect(
        findings.some(
          (finding) => finding.checkId === expectedFinding && finding.severity === "warn",
        ),
      ).toBe(true);
    }
    if (expectedNoFinding) {
      expect(findings.some((finding) => finding.checkId === expectedNoFinding)).toBe(false);
    }
  });
});
