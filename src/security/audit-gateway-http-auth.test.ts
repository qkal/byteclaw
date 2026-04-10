import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectGatewayHttpNoAuthFindings,
  collectGatewayHttpSessionKeyOverrideFindings,
} from "./audit-extra.sync.js";

describe("security audit gateway HTTP auth findings", () => {
  it.each([
    {
      cfg: {
        gateway: {
          auth: { mode: "none" },
          bind: "loopback",
          http: { endpoints: { chatCompletions: { enabled: true } } },
        },
      } satisfies OpenClawConfig,
      detailIncludes: ["/tools/invoke", "/v1/chat/completions"],
      env: {} as NodeJS.ProcessEnv,
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "warn" as const },
      name: "scores loopback gateway HTTP no-auth as warn",
    },
    {
      cfg: {
        gateway: {
          auth: { mode: "none" },
          bind: "lan",
          http: { endpoints: { responses: { enabled: true } } },
        },
      } satisfies OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "critical" as const },
      name: "scores remote gateway HTTP no-auth as critical",
    },
    {
      cfg: {
        gateway: {
          auth: { mode: "token", token: "secret" },
          bind: "loopback",
          http: {
            endpoints: {
              chatCompletions: { enabled: true },
              responses: { enabled: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      expectedNoFinding: "gateway.http.no_auth",
      name: "does not report gateway.http.no_auth when auth mode is token",
    },
    {
      cfg: {
        gateway: {
          http: {
            endpoints: {
              chatCompletions: { enabled: true },
              responses: { enabled: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedFinding: {
        checkId: "gateway.http.session_key_override_enabled",
        severity: "info" as const,
      },
      name: "reports HTTP API session-key override surfaces when enabled",
    },
  ])("$name", ({ cfg, expectedFinding, expectedNoFinding, detailIncludes, env }) => {
    const findings = [
      ...collectGatewayHttpNoAuthFindings(cfg, env ?? process.env),
      ...collectGatewayHttpSessionKeyOverrideFindings(cfg),
    ];

    if (expectedFinding) {
      expect(findings).toEqual(expect.arrayContaining([expect.objectContaining(expectedFinding)]));
      if (detailIncludes) {
        const finding = findings.find((entry) => entry.checkId === expectedFinding.checkId);
        for (const text of detailIncludes) {
          expect(finding?.detail, `${expectedFinding.checkId}:${text}`).toContain(text);
        }
      }
    }
    if (expectedNoFinding) {
      expect(findings.some((entry) => entry.checkId === expectedNoFinding)).toBe(false);
    }
  });
});
