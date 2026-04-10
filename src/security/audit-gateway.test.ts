import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { collectGatewayConfigFindings } from "./audit.js";

function hasFinding(checkId: string, findings: ReturnType<typeof collectGatewayConfigFindings>) {
  return findings.some((finding) => finding.checkId === checkId);
}

function hasFindingWithSeverity(
  checkId: string,
  severity: "info" | "warn" | "critical",
  findings: ReturnType<typeof collectGatewayConfigFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

describe("security audit gateway config findings", () => {
  it("evaluates gateway auth presence and rate-limit guardrails", async () => {
    await Promise.all([
      withEnvAsync(
        {
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
        },
        async () => {
          const findings = collectGatewayConfigFindings(
            {
              gateway: {
                auth: {},
                bind: "lan",
              },
            },
            {
              gateway: {
                auth: {},
                bind: "lan",
              },
            },
            process.env,
          );
          expect(hasFindingWithSeverity("gateway.bind_no_auth", "critical", findings)).toBe(true);
        },
      ),
      (async () => {
        const cfg: OpenClawConfig = {
          gateway: {
            auth: {
              password: {
                id: "OPENCLAW_GATEWAY_PASSWORD",
                provider: "default",
                source: "env",
              },
            },
            bind: "lan",
          },
        };
        const findings = collectGatewayConfigFindings(cfg, cfg, {});
        expect(hasFinding("gateway.bind_no_auth", findings)).toBe(false);
      })(),
      (async () => {
        const sourceConfig: OpenClawConfig = {
          gateway: {
            auth: {
              token: {
                id: "OPENCLAW_GATEWAY_TOKEN",
                provider: "default",
                source: "env",
              },
            },
            bind: "lan",
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        };
        const resolvedConfig: OpenClawConfig = {
          gateway: {
            auth: {},
            bind: "lan",
          },
          secrets: sourceConfig.secrets,
        };
        const findings = collectGatewayConfigFindings(resolvedConfig, sourceConfig, {});
        expect(hasFinding("gateway.bind_no_auth", findings)).toBe(false);
      })(),
      (async () => {
        const cfg: OpenClawConfig = {
          gateway: {
            auth: { token: "secret" },
            bind: "lan",
          },
        };
        const findings = collectGatewayConfigFindings(cfg, cfg, {});
        expect(hasFindingWithSeverity("gateway.auth_no_rate_limit", "warn", findings)).toBe(true);
      })(),
      (async () => {
        const cfg: OpenClawConfig = {
          gateway: {
            auth: {
              rateLimit: { lockoutMs: 300_000, maxAttempts: 10, windowMs: 60_000 },
              token: "secret",
            },
            bind: "lan",
          },
        };
        const findings = collectGatewayConfigFindings(cfg, cfg, {});
        expect(hasFinding("gateway.auth_no_rate_limit", findings)).toBe(false);
      })(),
    ]);
  });
});
