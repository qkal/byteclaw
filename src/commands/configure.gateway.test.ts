import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  buildGatewayAuthConfig: vi.fn(),
  confirm: vi.fn(),
  getTailnetHostname: vi.fn(),
  note: vi.fn(),
  randomToken: vi.fn(),
  resolveGatewayPort: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    resolveGatewayPort: mocks.resolveGatewayPort,
  };
});

vi.mock("./configure.shared.js", () => ({
  confirm: mocks.confirm,
  select: mocks.select,
  text: mocks.text,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./configure.gateway-auth.js", () => ({
  buildGatewayAuthConfig: mocks.buildGatewayAuthConfig,
}));

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
  getTailnetHostname: mocks.getTailnetHostname,
}));

vi.mock("./onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-helpers.js")>();
  return {
    ...actual,
    randomToken: mocks.randomToken,
  };
});

import { promptGatewayConfig } from "./configure.gateway.js";

function makeRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

async function runGatewayPrompt(params: {
  selectQueue: string[];
  textQueue: (string | undefined)[];
  baseConfig?: OpenClawConfig;
  randomToken?: string;
  confirmResult?: boolean;
  authConfigFactory?: (input: Record<string, unknown>) => Record<string, unknown>;
}) {
  vi.clearAllMocks();
  mocks.resolveGatewayPort.mockReturnValue(18_789);
  mocks.select.mockImplementation(async (input) => {
    const next = params.selectQueue.shift();
    if (next !== undefined) {
      return next;
    }
    return input.initialValue ?? input.options[0]?.value;
  });
  mocks.text.mockImplementation(async () => params.textQueue.shift());
  mocks.randomToken.mockReturnValue(params.randomToken ?? "generated-token");
  mocks.confirm.mockResolvedValue(params.confirmResult ?? true);
  mocks.buildGatewayAuthConfig.mockImplementation((input) =>
    params.authConfigFactory ? params.authConfigFactory(input as Record<string, unknown>) : input,
  );

  const result = await promptGatewayConfig(params.baseConfig ?? {}, makeRuntime());
  const call = mocks.buildGatewayAuthConfig.mock.calls[0]?.[0];
  return { call, result };
}

async function runTrustedProxyPrompt(params: {
  textQueue: (string | undefined)[];
  tailscaleMode?: "off" | "serve";
}) {
  return runGatewayPrompt({
    authConfigFactory: ({ mode, trustedProxy }) => ({ mode, trustedProxy }),
    selectQueue: ["loopback", "trusted-proxy", params.tailscaleMode ?? "off"],
    textQueue: params.textQueue,
  });
}

describe("promptGatewayConfig", () => {
  it("generates a token when the prompt returns undefined", async () => {
    const { result } = await runGatewayPrompt({
      authConfigFactory: ({ mode, token, password }) => ({ mode, password, token }),
      randomToken: "generated-token",
      selectQueue: ["loopback", "token", "off", "plaintext"],
      textQueue: ["18789", undefined],
    });
    expect(result.token).toBe("generated-token");
  });

  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    const { call } = await runGatewayPrompt({
      authConfigFactory: ({ mode, token, password }) => ({ mode, password, token }),
      randomToken: "unused",
      selectQueue: ["loopback", "password", "off"],
      textQueue: ["18789", undefined],
    });
    expect(call?.password).not.toBe("undefined");
    expect(call?.password).toBe("");
  });

  it("prompts for trusted-proxy configuration when trusted-proxy mode selected", async () => {
    const { result, call } = await runTrustedProxyPrompt({
      textQueue: [
        "18789",
        "x-forwarded-user",
        "x-forwarded-proto,x-forwarded-host",
        "nick@example.com",
        "10.0.1.10,192.168.1.5",
      ],
    });

    expect(call?.mode).toBe("trusted-proxy");
    expect(call?.trustedProxy).toEqual({
      allowUsers: ["nick@example.com"],
      requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
      userHeader: "x-forwarded-user",
    });
    expect(result.config.gateway?.bind).toBe("loopback");
    expect(result.config.gateway?.trustedProxies).toEqual(["10.0.1.10", "192.168.1.5"]);
  });

  it("handles trusted-proxy with no optional fields", async () => {
    const { result, call } = await runTrustedProxyPrompt({
      textQueue: ["18789", "x-remote-user", "", "", "10.0.0.1"],
    });

    expect(call?.mode).toBe("trusted-proxy");
    expect(call?.trustedProxy).toEqual({
      userHeader: "x-remote-user",
      // RequiredHeaders and allowUsers should be undefined when empty
    });
    expect(result.config.gateway?.bind).toBe("loopback");
    expect(result.config.gateway?.trustedProxies).toEqual(["10.0.0.1"]);
  });

  it("forces tailscale off when trusted-proxy is selected", async () => {
    const { result } = await runTrustedProxyPrompt({
      tailscaleMode: "serve",
      textQueue: ["18789", "x-forwarded-user", "", "", "10.0.0.1"],
    });
    expect(result.config.gateway?.bind).toBe("loopback");
    expect(result.config.gateway?.tailscale?.mode).toBe("off");
    expect(result.config.gateway?.tailscale?.resetOnExit).toBe(false);
  });

  it("adds Tailscale origin to controlUi.allowedOrigins when tailscale serve is enabled", async () => {
    mocks.getTailnetHostname.mockResolvedValue("my-host.tail1234.ts.net");
    const { result } = await runGatewayPrompt({
      // Bind=loopback, auth=token, tailscale=serve
      authConfigFactory: ({ mode, token }) => ({ mode, token }),
      confirmResult: true,
      selectQueue: ["loopback", "token", "serve", "plaintext"],
      textQueue: ["18789", "my-token"],
    });
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain(
      "https://my-host.tail1234.ts.net",
    );
  });

  it("adds Tailscale origin to controlUi.allowedOrigins when tailscale funnel is enabled", async () => {
    mocks.getTailnetHostname.mockResolvedValue("my-host.tail1234.ts.net");
    const { result } = await runGatewayPrompt({
      // Bind=loopback, auth=password (funnel requires password), tailscale=funnel
      authConfigFactory: ({ mode, password }) => ({ mode, password }),
      confirmResult: true,
      selectQueue: ["loopback", "password", "funnel"],
      textQueue: ["18789", "my-password"],
    });
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain(
      "https://my-host.tail1234.ts.net",
    );
  });

  it("does not add Tailscale origin when getTailnetHostname fails", async () => {
    mocks.getTailnetHostname.mockRejectedValue(new Error("not found"));
    const { result } = await runGatewayPrompt({
      authConfigFactory: ({ mode, token }) => ({ mode, token }),
      confirmResult: true,
      selectQueue: ["loopback", "token", "serve", "plaintext"],
      textQueue: ["18789", "my-token"],
    });
    expect(result.config.gateway?.controlUi?.allowedOrigins).toBeUndefined();
  });

  it("does not duplicate Tailscale origin if already present", async () => {
    mocks.getTailnetHostname.mockResolvedValue("my-host.tail1234.ts.net");
    const { result } = await runGatewayPrompt({
      authConfigFactory: ({ mode, token }) => ({ mode, token }),
      baseConfig: {
        gateway: {
          controlUi: {
            allowedOrigins: ["HTTPS://MY-HOST.TAIL1234.TS.NET"],
          },
        },
      },
      confirmResult: true,
      selectQueue: ["loopback", "token", "serve", "plaintext"],
      textQueue: ["18789", "my-token"],
    });
    const origins = result.config.gateway?.controlUi?.allowedOrigins ?? [];
    const tsOriginCount = origins.filter(
      (origin) => origin.toLowerCase() === "https://my-host.tail1234.ts.net",
    ).length;
    expect(tsOriginCount).toBe(1);
  });

  it("formats IPv6 Tailscale fallback addresses as valid HTTPS origins", async () => {
    mocks.getTailnetHostname.mockResolvedValue("fd7a:115c:a1e0::12");
    const { result } = await runGatewayPrompt({
      authConfigFactory: ({ mode, token }) => ({ mode, token }),
      confirmResult: true,
      selectQueue: ["loopback", "token", "serve", "plaintext"],
      textQueue: ["18789", "my-token"],
    });
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain(
      "https://[fd7a:115c:a1e0::12]",
    );
  });

  it("stores gateway token as SecretRef when token source is ref", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-gateway-token";
    try {
      const { call, result } = await runGatewayPrompt({
        authConfigFactory: ({ mode, token }) => ({ mode, token }),
        selectQueue: ["loopback", "token", "off", "ref"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_TOKEN"],
      });

      expect(call?.token).toEqual({
        id: "OPENCLAW_GATEWAY_TOKEN",
        provider: "default",
        source: "env",
      });
      expect(result.token).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous;
      }
    }
  });
});
