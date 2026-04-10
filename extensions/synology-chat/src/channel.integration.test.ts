import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContextMock,
  registerPluginHttpRouteMock,
  resolveAgentRouteMock,
} from "./channel.test-mocks.js";
import { makeFormBody, makeReq, makeRes } from "./test-http-utils.js";

interface _RegisteredRoute {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

let createSynologyChatPlugin: typeof import("./channel.js").createSynologyChatPlugin;
describe("Synology channel wiring integration", () => {
  beforeAll(async () => {
    ({ createSynologyChatPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    registerPluginHttpRouteMock.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    finalizeInboundContextMock.mockClear();
    resolveAgentRouteMock.mockClear();
  });

  it("registers real webhook handler with resolved account config and enforces allowlist", async () => {
    const plugin = createSynologyChatPlugin();
    const abortController = new AbortController();
    const ctx = {
      abortSignal: abortController.signal,
      accountId: "alerts",
      cfg: {
        channels: {
          "synology-chat": {
            accounts: {
              alerts: {
                allowedUserIds: ["456"],
                dmPolicy: "allowlist",
                enabled: true,
                incomingUrl: "https://nas.example.com/incoming",
                token: "valid-token",
                webhookPath: "/webhook/synology-alerts",
              },
            },
            enabled: true,
          },
        },
      },
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };

    const started = plugin.gateway.startAccount(ctx);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);

    const firstCall = registerPluginHttpRouteMock.mock.calls[0];
    expect(firstCall).toBeTruthy();
    if (!firstCall) {
      throw new Error("Expected registerPluginHttpRoute to be called");
    }
    const registered = firstCall[0];
    expect(registered.path).toBe("/webhook/synology-alerts");
    expect(registered.accountId).toBe("alerts");

    const req = makeReq(
      "POST",
      makeFormBody({
        text: "Hello",
        token: "valid-token",
        user_id: "123",
        username: "unauthorized-user",
      }),
    );
    const res = makeRes();
    await registered.handler(req, res);

    expect(res._status).toBe(403);
    expect(res._body).toContain("not authorized");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    abortController.abort();
    await started;
  });

  it("isolates same user_id across different accounts", async () => {
    const plugin = createSynologyChatPlugin();
    const alphaAbortController = new AbortController();
    const betaAbortController = new AbortController();
    const cfg = {
      channels: {
        "synology-chat": {
          accounts: {
            alpha: {
              dmPolicy: "open",
              enabled: true,
              incomingUrl: "https://nas.example.com/incoming-alpha",
              token: "token-alpha",
              webhookPath: "/webhook/synology-alpha",
            },
            beta: {
              dmPolicy: "open",
              enabled: true,
              incomingUrl: "https://nas.example.com/incoming-beta",
              token: "token-beta",
              webhookPath: "/webhook/synology-beta",
            },
          },
          enabled: true,
        },
      },
      session: {
        dmScope: "main" as const,
      },
    };

    const alphaStarted = plugin.gateway.startAccount({
      abortSignal: alphaAbortController.signal,
      accountId: "alpha",
      cfg,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    const betaStarted = plugin.gateway.startAccount({
      abortSignal: betaAbortController.signal,
      accountId: "beta",
      cfg,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(2);
    const alphaRoute = registerPluginHttpRouteMock.mock.calls[0]?.[0];
    const betaRoute = registerPluginHttpRouteMock.mock.calls[1]?.[0];
    if (!alphaRoute || !betaRoute) {
      throw new Error("Expected both Synology Chat routes to register");
    }

    const alphaReq = makeReq(
      "POST",
      makeFormBody({
        text: "alpha secret",
        token: "token-alpha",
        user_id: "123",
        username: "alice",
      }),
    );
    const alphaRes = makeRes();
    await alphaRoute.handler(alphaReq, alphaRes);

    const betaReq = makeReq(
      "POST",
      makeFormBody({
        text: "beta secret",
        token: "token-beta",
        user_id: "123",
        username: "bob",
      }),
    );
    const betaRes = makeRes();
    await betaRoute.handler(betaReq, betaRes);

    expect(alphaRes._status).toBe(204);
    expect(betaRes._status).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(finalizeInboundContextMock).toHaveBeenCalledTimes(2);

    const alphaCtx = finalizeInboundContextMock.mock.calls[0]?.[0];
    const betaCtx = finalizeInboundContextMock.mock.calls[1]?.[0];
    expect(alphaCtx).toMatchObject({
      AccountId: "alpha",
      SessionKey: "agent:agent-alpha:synology-chat:alpha:direct:123",
    });
    expect(betaCtx).toMatchObject({
      AccountId: "beta",
      SessionKey: "agent:agent-beta:synology-chat:beta:direct:123",
    });

    alphaAbortController.abort();
    betaAbortController.abort();
    await alphaStarted;
    await betaStarted;
  });
});
