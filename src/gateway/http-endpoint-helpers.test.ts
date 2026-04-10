import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: vi.fn(),
  resolveTrustedHttpOperatorScopes: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  readJsonBodyOrError: vi.fn(),
  sendJson: vi.fn(),
  sendMethodNotAllowed: vi.fn(),
}));

vi.mock("./method-scopes.js", () => ({
  authorizeOperatorScopesForMethod: vi.fn(),
}));

const { readJsonBodyOrError, sendJson, sendMethodNotAllowed } = await import("./http-common.js");
const { authorizeGatewayHttpRequestOrReply, resolveTrustedHttpOperatorScopes } =
  await import("./http-utils.js");
const { authorizeOperatorScopesForMethod } = await import("./method-scopes.js");

describe("handleGatewayPostJsonEndpoint", () => {
  it("returns false when path does not match", async () => {
    const result = await handleGatewayPostJsonEndpoint(
      {
        headers: { host: "localhost" },
        method: "POST",
        url: "/nope",
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 1, pathname: "/v1/ok" },
    );
    expect(result).toBe(false);
  });

  it("returns undefined and replies when method is not POST", async () => {
    const mockedSendMethodNotAllowed = vi.mocked(sendMethodNotAllowed);
    mockedSendMethodNotAllowed.mockClear();
    const result = await handleGatewayPostJsonEndpoint(
      {
        headers: { host: "localhost" },
        method: "GET",
        url: "/v1/ok",
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 1, pathname: "/v1/ok" },
    );
    expect(result).toBeUndefined();
    expect(mockedSendMethodNotAllowed).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when auth fails", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue(null);
    const result = await handleGatewayPostJsonEndpoint(
      {
        headers: { host: "localhost" },
        method: "POST",
        url: "/v1/ok",
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 1, pathname: "/v1/ok" },
    );
    expect(result).toBeUndefined();
  });

  it("returns body when auth succeeds and JSON parsing succeeds", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      trustDeclaredOperatorScopes: true,
    });
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ hello: "world" });
    const result = await handleGatewayPostJsonEndpoint(
      {
        headers: { host: "localhost" },
        method: "POST",
        url: "/v1/ok",
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 123, pathname: "/v1/ok" },
    );
    expect(result).toEqual({
      body: { hello: "world" },
      requestAuth: { trustDeclaredOperatorScopes: true },
    });
  });

  it("returns undefined and replies when required operator scope is missing", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      trustDeclaredOperatorScopes: false,
    });
    vi.mocked(resolveTrustedHttpOperatorScopes).mockReturnValue(["operator.approvals"]);
    vi.mocked(authorizeOperatorScopesForMethod).mockReturnValue({
      allowed: false,
      missingScope: "operator.write",
    });
    const mockedSendJson = vi.mocked(sendJson);
    mockedSendJson.mockClear();
    vi.mocked(readJsonBodyOrError).mockClear();

    const result = await handleGatewayPostJsonEndpoint(
      {
        headers: { host: "localhost" },
        method: "POST",
        url: "/v1/ok",
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      {
        auth: {} as unknown as ResolvedGatewayAuth,
        maxBodyBytes: 123,
        pathname: "/v1/ok",
        requiredOperatorMethod: "chat.send",
      },
    );

    expect(result).toBeUndefined();
    expect(vi.mocked(authorizeOperatorScopesForMethod)).toHaveBeenCalledWith("chat.send", [
      "operator.approvals",
    ]);
    expect(mockedSendJson).toHaveBeenCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({
        error: expect.objectContaining({
          message: "missing scope: operator.write",
          type: "forbidden",
        }),
        ok: false,
      }),
    );
    expect(vi.mocked(readJsonBodyOrError)).not.toHaveBeenCalled();
  });

  it("uses a custom operator scope resolver when provided", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      authMethod: "token",
      trustDeclaredOperatorScopes: false,
    });
    vi.mocked(authorizeOperatorScopesForMethod).mockReturnValue({ allowed: true });
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ ok: true });
    const resolveOperatorScopes = vi.fn(() => ["operator.admin", "operator.write"]);

    const result = await handleGatewayPostJsonEndpoint(
      {
        headers: { host: "localhost" },
        method: "POST",
        url: "/v1/ok",
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      {
        auth: {} as unknown as ResolvedGatewayAuth,
        maxBodyBytes: 123,
        pathname: "/v1/ok",
        requiredOperatorMethod: "chat.send",
        resolveOperatorScopes,
      },
    );

    expect(resolveOperatorScopes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        authMethod: "token",
        trustDeclaredOperatorScopes: false,
      }),
    );
    expect(result).toEqual({
      body: { ok: true },
      requestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
    });
  });
});
