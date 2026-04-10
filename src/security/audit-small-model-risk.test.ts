import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSmallModelRiskFindings } from "./audit-extra.summary.js";

describe("security audit small-model risk findings", () => {
  it("scores small-model risk by tool/sandbox exposure", () => {
    const cases: {
      name: string;
      cfg: OpenClawConfig;
      expectedSeverity: "info" | "critical";
      detailIncludes: string[];
    }[] = [
      {
        cfg: {
          agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
          browser: { enabled: true },
          tools: { web: { fetch: { enabled: true }, search: { enabled: true } } },
        },
        detailIncludes: ["mistral-8b", "web_search", "web_fetch", "browser"],
        expectedSeverity: "critical",
        name: "small model with web and browser enabled",
      },
      {
        cfg: {
          agents: {
            defaults: { model: { primary: "ollama/mistral-8b" }, sandbox: { mode: "all" } },
          },
          browser: { enabled: false },
          tools: { web: { fetch: { enabled: false }, search: { enabled: false } } },
        },
        detailIncludes: ["mistral-8b", "sandbox=all"],
        expectedSeverity: "info",
        name: "small model with sandbox all and web/browser disabled",
      },
    ];

    for (const testCase of cases) {
      const [finding] = collectSmallModelRiskFindings({
        cfg: testCase.cfg,
        env: process.env,
      });
      expect(finding?.severity, testCase.name).toBe(testCase.expectedSeverity);
      for (const snippet of testCase.detailIncludes) {
        expect(finding?.detail, `${testCase.name}:${snippet}`).toContain(snippet);
      }
    }
  });
});
