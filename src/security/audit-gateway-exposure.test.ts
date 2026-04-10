import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectGatewayConfigFindings } from "./audit.js";

function hasFinding(
  checkId: string,
  severity: "warn" | "critical",
  findings: ReturnType<typeof collectGatewayConfigFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

describe("security audit gateway exposure findings", () => {
  it("warns on insecure or dangerous flags", () => {
    const cases = [
      {
        cfg: {
          gateway: {
            controlUi: { allowInsecureAuth: true },
          },
        } satisfies OpenClawConfig,
        expectedDangerousDetails: ["gateway.controlUi.allowInsecureAuth=true"],
        expectedFinding: {
          checkId: "gateway.control_ui.insecure_auth",
          severity: "warn",
        },
        name: "control UI allows insecure auth",
      },
      {
        cfg: {
          gateway: {
            controlUi: { dangerouslyDisableDeviceAuth: true },
          },
        } satisfies OpenClawConfig,
        expectedDangerousDetails: ["gateway.controlUi.dangerouslyDisableDeviceAuth=true"],
        expectedFinding: {
          checkId: "gateway.control_ui.device_auth_disabled",
          severity: "critical",
        },
        name: "control UI device auth is disabled",
      },
      {
        cfg: {
          hooks: {
            gmail: { allowUnsafeExternalContent: true },
            mappings: [{ allowUnsafeExternalContent: true }],
          },
          tools: {
            exec: {
              applyPatch: {
                workspaceOnly: false,
              },
            },
          },
        } satisfies OpenClawConfig,
        expectedDangerousDetails: [
          "hooks.gmail.allowUnsafeExternalContent=true",
          "hooks.mappings[0].allowUnsafeExternalContent=true",
          "tools.exec.applyPatch.workspaceOnly=false",
        ],
        name: "generic insecure debug flags",
      },
      {
        cfg: {
          plugins: {
            entries: {
              acpx: {
                config: {
                  permissionMode: "approve-all",
                },
                enabled: true,
              },
            },
          },
        } satisfies OpenClawConfig,
        expectedDangerousDetails: ["plugins.entries.acpx.config.permissionMode=approve-all"],
        name: "acpx approve-all is treated as a dangerous break-glass flag",
      },
    ] as const;

    for (const testCase of cases) {
      const findings = collectGatewayConfigFindings(testCase.cfg, testCase.cfg, {});
      if ("expectedFinding" in testCase) {
        expect(findings, testCase.name).toEqual(
          expect.arrayContaining([expect.objectContaining(testCase.expectedFinding)]),
        );
      }
      const finding = findings.find(
        (entry) => entry.checkId === "config.insecure_or_dangerous_flags",
      );
      expect(finding, testCase.name).toBeTruthy();
      expect(finding?.severity, testCase.name).toBe("warn");
      for (const snippet of testCase.expectedDangerousDetails) {
        expect(finding?.detail, `${testCase.name}:${snippet}`).toContain(snippet);
      }
    }
  });

  it.each([
    {
      cfg: {
        gateway: {
          auth: { mode: "token", token: "very-long-browser-token-0123456789" },
          bind: "lan",
        },
      } satisfies OpenClawConfig,
      expectedFinding: {
        checkId: "gateway.control_ui.allowed_origins_required",
        severity: "critical",
      },
      name: "flags non-loopback Control UI without allowed origins",
    },
    {
      cfg: {
        gateway: {
          bind: "loopback",
          controlUi: { allowedOrigins: ["*"] },
        },
      } satisfies OpenClawConfig,
      expectedFinding: {
        checkId: "gateway.control_ui.allowed_origins_wildcard",
        severity: "warn",
      },
      name: "flags wildcard Control UI origins by exposure level on loopback",
    },
    {
      cfg: {
        gateway: {
          auth: { mode: "token", token: "very-long-browser-token-0123456789" },
          bind: "lan",
          controlUi: { allowedOrigins: ["*"] },
        },
      } satisfies OpenClawConfig,
      expectedFinding: {
        checkId: "gateway.control_ui.allowed_origins_wildcard",
        severity: "critical",
      },
      expectedNoFinding: "gateway.control_ui.allowed_origins_required",
      name: "flags wildcard Control UI origins by exposure level when exposed",
    },
  ])("$name", ({ cfg, expectedFinding, expectedNoFinding }) => {
    const findings = collectGatewayConfigFindings(cfg, cfg, {});
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining(expectedFinding)]));
    if (expectedNoFinding) {
      expect(findings.some((finding) => finding.checkId === expectedNoFinding)).toBe(false);
    }
  });

  it("flags dangerous host-header origin fallback and suppresses missing allowed-origins finding", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "token", token: "very-long-browser-token-0123456789" },
        bind: "lan",
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true,
        },
      },
    };

    const findings = collectGatewayConfigFindings(cfg, cfg, {});
    expect(hasFinding("gateway.control_ui.host_header_origin_fallback", "critical", findings)).toBe(
      true,
    );
    expect(
      findings.some((finding) => finding.checkId === "gateway.control_ui.allowed_origins_required"),
    ).toBe(false);
    const flags = findings.find(
      (finding) => finding.checkId === "config.insecure_or_dangerous_flags",
    );
    expect(flags?.detail ?? "").toContain(
      "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true",
    );
  });

  it.each([
    {
      cfg: {
        gateway: {
          allowRealIpFallback: true,
          auth: {
            mode: "token",
            token: "very-long-token-1234567890",
          },
          bind: "loopback",
          trustedProxies: ["127.0.0.1"],
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "warn" as const,
      name: "loopback gateway",
    },
    {
      cfg: {
        gateway: {
          allowRealIpFallback: true,
          auth: {
            mode: "token",
            token: "very-long-token-1234567890",
          },
          bind: "lan",
          trustedProxies: ["10.0.0.1"],
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "critical" as const,
      name: "lan gateway",
    },
    {
      cfg: {
        gateway: {
          allowRealIpFallback: true,
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          bind: "loopback",
          trustedProxies: ["127.0.0.1"],
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "warn" as const,
      name: "loopback trusted-proxy with loopback-only proxies",
    },
    {
      cfg: {
        gateway: {
          allowRealIpFallback: true,
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          bind: "loopback",
          trustedProxies: ["127.0.0.1", "10.0.0.0/8"],
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "critical" as const,
      name: "loopback trusted-proxy with non-loopback proxy range",
    },
    {
      cfg: {
        gateway: {
          allowRealIpFallback: true,
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          bind: "loopback",
          trustedProxies: ["127.0.0.2"],
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "critical" as const,
      name: "loopback trusted-proxy with 127.0.0.2",
    },
    {
      cfg: {
        gateway: {
          allowRealIpFallback: true,
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          bind: "loopback",
          trustedProxies: ["127.0.0.0/8"],
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "critical" as const,
      name: "loopback trusted-proxy with 127.0.0.0/8 range",
    },
  ])("scores X-Real-IP fallback risk by gateway exposure: $name", ({ cfg, expectedSeverity }) => {
    expect(
      hasFinding(
        "gateway.real_ip_fallback_enabled",
        expectedSeverity,
        collectGatewayConfigFindings(cfg, cfg, {}),
      ),
    ).toBe(true);
  });

  it.each([
    {
      cfg: {
        discovery: {
          mdns: { mode: "full" },
        },
        gateway: {
          auth: {
            mode: "token",
            token: "very-long-token-1234567890",
          },
          bind: "loopback",
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "warn" as const,
      name: "loopback gateway with full mDNS",
    },
    {
      cfg: {
        discovery: {
          mdns: { mode: "full" },
        },
        gateway: {
          auth: {
            mode: "token",
            token: "very-long-token-1234567890",
          },
          bind: "lan",
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "critical" as const,
      name: "lan gateway with full mDNS",
    },
  ])("scores mDNS full mode risk by gateway bind mode: $name", ({ cfg, expectedSeverity }) => {
    expect(
      hasFinding(
        "discovery.mdns_full_mode",
        expectedSeverity,
        collectGatewayConfigFindings(cfg, cfg, {}),
      ),
    ).toBe(true);
  });

  it("evaluates trusted-proxy auth guardrails", () => {
    const cases: {
      name: string;
      cfg: OpenClawConfig;
      expectedCheckId: string;
      expectedSeverity: "warn" | "critical";
      suppressesGenericSharedSecretFindings?: boolean;
    }[] = [
      {
        cfg: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
            bind: "lan",
            trustedProxies: ["10.0.0.1"],
          },
        },
        expectedCheckId: "gateway.trusted_proxy_auth",
        expectedSeverity: "critical",
        name: "trusted-proxy base mode",
        suppressesGenericSharedSecretFindings: true,
      },
      {
        cfg: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
            bind: "lan",
            trustedProxies: [],
          },
        },
        expectedCheckId: "gateway.trusted_proxy_no_proxies",
        expectedSeverity: "critical",
        name: "missing trusted proxies",
      },
      {
        cfg: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {} as never,
            },
            bind: "lan",
            trustedProxies: ["10.0.0.1"],
          },
        },
        expectedCheckId: "gateway.trusted_proxy_no_user_header",
        expectedSeverity: "critical",
        name: "missing user header",
      },
      {
        cfg: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {
                allowUsers: [],
                userHeader: "x-forwarded-user",
              },
            },
            bind: "lan",
            trustedProxies: ["10.0.0.1"],
          },
        },
        expectedCheckId: "gateway.trusted_proxy_no_allowlist",
        expectedSeverity: "warn",
        name: "missing user allowlist",
      },
    ];

    for (const testCase of cases) {
      const findings = collectGatewayConfigFindings(testCase.cfg, testCase.cfg, {});
      expect(
        hasFinding(testCase.expectedCheckId, testCase.expectedSeverity, findings),
        testCase.name,
      ).toBe(true);
      if (testCase.suppressesGenericSharedSecretFindings) {
        expect(findings.some((finding) => finding.checkId === "gateway.bind_no_auth")).toBe(false);
        expect(findings.some((finding) => finding.checkId === "gateway.auth_no_rate_limit")).toBe(
          false,
        );
      }
    }
  });
});
