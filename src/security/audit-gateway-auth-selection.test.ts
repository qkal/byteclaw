import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafe, resolveGatewayProbeTarget } from "../gateway/probe-auth.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";

describe("security audit gateway auth selection", () => {
  it("applies gateway auth precedence across local and remote modes", async () => {
    const makeProbeEnv = (env?: { token?: string; password?: string }) => {
      const probeEnv: NodeJS.ProcessEnv = {};
      if (env?.token !== undefined) {
        probeEnv.OPENCLAW_GATEWAY_TOKEN = env.token;
      }
      if (env?.password !== undefined) {
        probeEnv.OPENCLAW_GATEWAY_PASSWORD = env.password;
      }
      return probeEnv;
    };

    const cases: {
      name: string;
      cfg: OpenClawConfig;
      env?: { token?: string; password?: string };
      expectedAuth: { token?: string; password?: string };
    }[] = [
      {
        cfg: { gateway: { auth: { token: "local-token-abc123" }, mode: "local" } },
        expectedAuth: { token: "local-token-abc123" },
        name: "uses local auth when gateway.mode is local",
      },
      {
        cfg: { gateway: { auth: { token: "local-token" }, mode: "local" } },
        env: { token: "env-token" },
        expectedAuth: { token: "env-token" },
        name: "prefers env token over local config token",
      },
      {
        cfg: { gateway: { auth: { token: "default-local-token" } } },
        expectedAuth: { token: "default-local-token" },
        name: "uses local auth when gateway.mode is undefined (default)",
      },
      {
        cfg: {
          gateway: {
            auth: { token: "local-token-should-not-use" },
            mode: "remote",
            remote: { token: "remote-token-xyz789", url: "wss://remote.example.com:18789" },
          },
        },
        expectedAuth: { token: "remote-token-xyz789" },
        name: "uses remote auth when gateway.mode is remote with URL",
      },
      {
        cfg: {
          gateway: {
            auth: { token: "local-token-should-not-use" },
            mode: "remote",
            remote: { token: "remote-token", url: "wss://remote.example.com:18789" },
          },
        },
        env: { token: "env-token" },
        expectedAuth: { token: "remote-token" },
        name: "ignores env token when gateway.mode is remote",
      },
      {
        cfg: {
          gateway: {
            auth: { token: "fallback-local-token" },
            mode: "remote",
            remote: { token: "remote-token-should-not-use" },
          },
        },
        expectedAuth: { token: "fallback-local-token" },
        name: "falls back to local auth when gateway.mode is remote but URL is missing",
      },
      {
        cfg: {
          gateway: {
            mode: "remote",
            remote: { password: "remote-pass", url: "wss://remote.example.com:18789" },
          },
        },
        expectedAuth: { password: "remote-pass" },
        name: "uses remote password when env is unset",
      },
      {
        cfg: {
          gateway: {
            mode: "remote",
            remote: { password: "remote-pass", url: "wss://remote.example.com:18789" },
          },
        },
        env: { password: "env-pass" },
        expectedAuth: { password: "env-pass" },
        name: "prefers env password over remote password",
      },
    ];

    await Promise.all(
      cases.map(async (testCase) => {
        const target = resolveGatewayProbeTarget(testCase.cfg);
        const result = resolveGatewayProbeAuthSafe({
          cfg: testCase.cfg,
          env: makeProbeEnv(testCase.env),
          mode: target.mode,
        });
        expect(result.auth, testCase.name).toEqual(testCase.expectedAuth);
      }),
    );
  });

  it("adds warning finding when probe auth SecretRef is unavailable", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_GATEWAY_TOKEN", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    const result = resolveGatewayProbeAuthSafe({
      cfg,
      env: {},
      mode: "local",
    });
    const warning = collectDeepProbeFindings({
      authWarning: result.warning,
      deep: {
        gateway: {
          attempted: true,
          close: null,
          error: null,
          ok: true,
          url: "ws://127.0.0.1:18789",
        },
      },
    }).find((finding) => finding.checkId === "gateway.probe_auth_secretref_unavailable");
    expect(warning?.severity).toBe("warn");
    expect(warning?.detail).toContain("gateway.auth.token");
  });
});
