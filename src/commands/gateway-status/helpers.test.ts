import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  buildNetworkHints,
  extractConfigSummary,
  isProbeReachable,
  isScopeLimitedProbeFailure,
  renderProbeSummaryLine,
  resolveAuthForTarget,
  resolveProbeBudgetMs,
  resolveTargets,
} from "./helpers.js";

describe("extractConfigSummary", () => {
  it("marks SecretRef-backed gateway auth credentials as configured", () => {
    const summary = extractConfigSummary({
      config: {
        gateway: {
          auth: {
            mode: "token",
            password: { id: "OPENCLAW_GATEWAY_PASSWORD", provider: "default", source: "env" },
            token: { id: "OPENCLAW_GATEWAY_TOKEN", provider: "default", source: "env" },
          },
          remote: {
            password: { id: "REMOTE_GATEWAY_PASSWORD", provider: "default", source: "env" },
            token: { id: "REMOTE_GATEWAY_TOKEN", provider: "default", source: "env" },
            url: "wss://remote.example:18789",
          },
        },
        secrets: {
          defaults: {
            env: "default",
          },
        },
      },
      exists: true,
      issues: [],
      legacyIssues: [],
      path: "/tmp/openclaw.json",
      valid: true,
    });

    expect(summary.gateway.authTokenConfigured).toBe(true);
    expect(summary.gateway.authPasswordConfigured).toBe(true);
    expect(summary.gateway.remoteTokenConfigured).toBe(true);
    expect(summary.gateway.remotePasswordConfigured).toBe(true);
  });

  it("still treats empty plaintext auth values as not configured", () => {
    const summary = extractConfigSummary({
      config: {
        gateway: {
          auth: {
            mode: "token",
            password: "",
            token: "   ",
          },
          remote: {
            password: "",
            token: " ",
          },
        },
      },
      exists: true,
      issues: [],
      legacyIssues: [],
      path: "/tmp/openclaw.json",
      valid: true,
    });

    expect(summary.gateway.authTokenConfigured).toBe(false);
    expect(summary.gateway.authPasswordConfigured).toBe(false);
    expect(summary.gateway.remoteTokenConfigured).toBe(false);
    expect(summary.gateway.remotePasswordConfigured).toBe(false);
  });
});

describe("resolveAuthForTarget", () => {
  function createConfigRemoteTarget() {
    return {
      active: true,
      id: "configRemote",
      kind: "configRemote" as const,
      url: "wss://remote.example:18789",
    };
  }

  function createRemoteGatewayTargetConfig(params?: { mode?: "none" | "password" | "token" }) {
    return {
      gateway: {
        ...(params?.mode
          ? {
              auth: {
                mode: params.mode,
              },
            }
          : {}),
        remote: {
          token: { id: "REMOTE_GATEWAY_TOKEN", provider: "default", source: "env" as const },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" as const },
        },
      },
    };
  }

  it("resolves local auth token SecretRef before probing local targets", async () => {
    await withEnvAsync(
      {
        LOCAL_GATEWAY_TOKEN: "resolved-local-token",
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            gateway: {
              auth: {
                token: { id: "LOCAL_GATEWAY_TOKEN", provider: "default", source: "env" },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
          {
            active: true,
            id: "localLoopback",
            kind: "localLoopback",
            url: "ws://127.0.0.1:18789",
          },
          {},
        );

        expect(auth).toEqual({ password: undefined, token: "resolved-local-token" });
      },
    );
  });

  it("resolves remote auth token SecretRef before probing remote targets", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          createRemoteGatewayTargetConfig(),
          createConfigRemoteTarget(),
          {},
        );

        expect(auth).toEqual({ password: undefined, token: "resolved-remote-token" });
      },
    );
  });

  it("resolves remote auth even when local auth mode is none", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          createRemoteGatewayTargetConfig({ mode: "none" }),
          createConfigRemoteTarget(),
          {},
        );

        expect(auth).toEqual({ password: undefined, token: "resolved-remote-token" });
      },
    );
  });

  it("does not force remote auth type from local auth mode", async () => {
    const auth = await resolveAuthForTarget(
      {
        gateway: {
          auth: {
            mode: "password",
          },
          remote: {
            password: "remote-password",
            token: "remote-token", // Pragma: allowlist secret
          },
        },
      },
      {
        active: true,
        id: "configRemote",
        kind: "configRemote",
        url: "wss://remote.example:18789",
      },
      {},
    );

    expect(auth).toEqual({ password: undefined, token: "remote-token" });
  });

  it("redacts resolver internals from unresolved SecretRef diagnostics", async () => {
    await withEnvAsync(
      {
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            gateway: {
              auth: {
                mode: "token",
                token: { id: "MISSING_GATEWAY_TOKEN", provider: "default", source: "env" },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
          {
            active: true,
            id: "localLoopback",
            kind: "localLoopback",
            url: "ws://127.0.0.1:18789",
          },
          {},
        );

        expect(auth.diagnostics).toContain(
          "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
        );
        expect(auth.diagnostics?.join("\n")).not.toContain("missing or empty");
      },
    );
  });
});

describe("probe reachability classification", () => {
  it("treats missing-scope RPC failures as scope-limited and reachable", () => {
    const probe = {
      close: null,
      configSnapshot: null,
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
      health: null,
      ok: false,
      presence: null,
      status: null,
      url: "ws://127.0.0.1:18789",
    };

    expect(isScopeLimitedProbeFailure(probe)).toBe(true);
    expect(isProbeReachable(probe)).toBe(true);
    expect(renderProbeSummaryLine(probe, false)).toContain("RPC: limited");
  });

  it("keeps non-scope RPC failures as unreachable", () => {
    const probe = {
      close: null,
      configSnapshot: null,
      connectLatencyMs: 43,
      error: "unknown method: status",
      health: null,
      ok: false,
      presence: null,
      status: null,
      url: "ws://127.0.0.1:18789",
    };

    expect(isScopeLimitedProbeFailure(probe)).toBe(false);
    expect(isProbeReachable(probe)).toBe(false);
    expect(renderProbeSummaryLine(probe, false)).toContain("RPC: failed");
  });
});
describe("gateway-status local target scheme", () => {
  it("uses wss for local loopback targets and network hints when gateway TLS is enabled", () => {
    const cfg = {
      gateway: {
        mode: "local",
        tls: { enabled: true },
      },
    };

    const targets = resolveTargets(cfg as never);
    expect(targets).toContainEqual(
      expect.objectContaining({
        id: "localLoopback",
        url: "wss://127.0.0.1:18789",
      }),
    );

    const hints = buildNetworkHints(cfg as never);
    expect(hints.localLoopbackUrl).toBe("wss://127.0.0.1:18789");
  });
});

describe("resolveProbeBudgetMs", () => {
  it("lets active local loopback probes use the full caller budget", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        active: true,
        kind: "localLoopback",
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(15_000);
    expect(
      resolveProbeBudgetMs(3000, {
        active: true,
        kind: "localLoopback",
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(3000);
  });

  it("keeps inactive local loopback probes on the short cap", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        active: false,
        kind: "localLoopback",
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(800);
    expect(
      resolveProbeBudgetMs(500, {
        active: false,
        kind: "localLoopback",
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(500);
  });

  it("lets explicit loopback URLs use the full caller budget", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        active: true,
        kind: "explicit",
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(15_000);
    expect(
      resolveProbeBudgetMs(2500, {
        active: true,
        kind: "explicit",
        url: "wss://localhost:18789/ws",
      }),
    ).toBe(2500);
  });

  it("keeps non-local probe caps unchanged", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        active: true,
        kind: "configRemote",
        url: "wss://gateway.example/ws",
      }),
    ).toBe(1500);
    expect(
      resolveProbeBudgetMs(15_000, {
        active: true,
        kind: "explicit",
        url: "wss://gateway.example/ws",
      }),
    ).toBe(1500);
    expect(
      resolveProbeBudgetMs(15_000, {
        active: true,
        kind: "sshTunnel",
        url: "wss://gateway.example/ws",
      }),
    ).toBe(2000);
  });
});
