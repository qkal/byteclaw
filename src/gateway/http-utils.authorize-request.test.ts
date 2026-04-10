import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    gateway: {
      controlUi: {
        allowedOrigins: ["https://control.example.com"],
      },
    },
  })),
}));

vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const { authorizeGatewayHttpRequestOrReply } = await import("./http-utils.js");

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("authorizeGatewayHttpRequestOrReply", () => {
  beforeEach(() => {
    vi.mocked(authorizeHttpGatewayConnect).mockReset();
    vi.mocked(sendGatewayAuthFailure).mockReset();
  });

  it("marks token-authenticated requests as untrusted for declared HTTP scopes", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      method: "token",
      ok: true,
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        auth: { allowTailscale: false, mode: "trusted-proxy", token: "secret" },
        req: createReq({ authorization: "Bearer secret" }),
        res: {} as ServerResponse,
        trustedProxies: ["127.0.0.1"],
      }),
    ).resolves.toEqual({
      authMethod: "token",
      trustDeclaredOperatorScopes: false,
    });
  });

  it("keeps trusted-proxy requests eligible for declared HTTP scopes", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      method: "trusted-proxy",
      ok: true,
      user: "operator",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        auth: {
          allowTailscale: false,
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-user" },
        },
        req: createReq({ authorization: "Bearer upstream-idp-token" }),
        res: {} as ServerResponse,
        trustedProxies: ["127.0.0.1"],
      }),
    ).resolves.toEqual({
      authMethod: "trusted-proxy",
      trustDeclaredOperatorScopes: true,
    });
  });

  it("forwards browser-origin policy into HTTP auth", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      method: "trusted-proxy",
      ok: true,
      user: "operator",
    });

    await authorizeGatewayHttpRequestOrReply({
      auth: {
        allowTailscale: false,
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-user" },
      },
      req: createReq({
        host: "gateway.example.com",
        origin: "https://evil.example",
      }),
      res: {} as ServerResponse,
      trustedProxies: ["127.0.0.1"],
    });

    expect(vi.mocked(authorizeHttpGatewayConnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        browserOriginPolicy: {
          allowHostHeaderOriginFallback: false,
          allowedOrigins: ["https://control.example.com"],
          origin: "https://evil.example",
          requestHost: "gateway.example.com",
        },
      }),
    );
  });

  it("replies with auth failure and returns null when auth fails", async () => {
    const res = {} as ServerResponse;
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      reason: "unauthorized",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        auth: { allowTailscale: false, mode: "token", token: "secret" },
        req: createReq(),
        res,
      }),
    ).resolves.toBeNull();

    expect(sendGatewayAuthFailure).toHaveBeenCalledWith(res, {
      ok: false,
      reason: "unauthorized",
    });
  });
});
