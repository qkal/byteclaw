import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createMockServerResponse } from "../../../test/helpers/plugins/mock-http-response.js";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { verifyGoogleChatRequest } from "./auth.js";
import { handleGoogleChatWebhookRequest, registerGoogleChatWebhookTarget } from "./monitor.js";

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest: vi.fn(),
}));

function createWebhookRequest(params: {
  authorization?: string;
  payload: unknown;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
    on: (event: string, listener: (...args: unknown[]) => void) => IncomingMessage;
  };
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  req.destroyed = false;
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };

  const originalOn = req.on.bind(req);
  let bodyScheduled = false;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = originalOn(event, listener);
    if (!bodyScheduled && event === "data") {
      bodyScheduled = true;
      void Promise.resolve().then(() => {
        req.emit("data", Buffer.from(JSON.stringify(params.payload), "utf8"));
        if (!req.destroyed) {
          req.emit("end");
        }
      });
    }
    return result;
  }) as IncomingMessage["on"];

  return req;
}

function createHeaderOnlyWebhookRequest(params: {
  authorization?: string;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  return req;
}

const baseAccount = (accountId: string) =>
  ({
    accountId,
    config: {},
    credentialSource: "none",
    enabled: true,
  }) as ResolvedGoogleChatAccount;

function registerTwoTargets() {
  const sinkA = vi.fn();
  const sinkB = vi.fn();
  const core = {} as PluginRuntime;
  const config = {} as OpenClawConfig;

  const unregisterA = registerGoogleChatWebhookTarget({
    account: baseAccount("A"),
    config,
    core,
    mediaMaxMb: 5,
    path: "/googlechat",
    runtime: {},
    statusSink: sinkA,
  });
  const unregisterB = registerGoogleChatWebhookTarget({
    account: baseAccount("B"),
    config,
    core,
    mediaMaxMb: 5,
    path: "/googlechat",
    runtime: {},
    statusSink: sinkB,
  });

  return {
    sinkA,
    sinkB,
    unregister: () => {
      unregisterA();
      unregisterB();
    },
  };
}

async function dispatchWebhookRequest(req: IncomingMessage) {
  const res = createMockServerResponse();
  const handled = await handleGoogleChatWebhookRequest(req, res);
  expect(handled).toBe(true);
  return res;
}

async function expectVerifiedRoute(params: {
  request: IncomingMessage;
  expectedStatus: number;
  sinkA: ReturnType<typeof vi.fn>;
  sinkB: ReturnType<typeof vi.fn>;
  expectedSink: "none" | "A" | "B";
}) {
  const res = await dispatchWebhookRequest(params.request);
  expect(res.statusCode).toBe(params.expectedStatus);
  const expectedCounts =
    params.expectedSink === "A" ? [1, 0] : (params.expectedSink === "B" ? [0, 1] : [0, 0]);
  expect(params.sinkA).toHaveBeenCalledTimes(expectedCounts[0]);
  expect(params.sinkB).toHaveBeenCalledTimes(expectedCounts[1]);
}

function mockSecondVerifierSuccess() {
  vi.mocked(verifyGoogleChatRequest)
    .mockResolvedValueOnce({ ok: false, reason: "invalid" })
    .mockResolvedValueOnce({ ok: true });
}

describe("Google Chat webhook routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("rejects ambiguous routing when multiple targets on the same path verify successfully", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });

    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        expectedSink: "none",
        expectedStatus: 401,
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { space: { name: "spaces/AAA" }, type: "ADDED_TO_SPACE" },
        }),
        sinkA,
        sinkB,
      });
    } finally {
      unregister();
    }
  });

  it("routes to the single verified target when earlier targets fail verification", async () => {
    mockSecondVerifierSuccess();

    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        expectedSink: "B",
        expectedStatus: 200,
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { space: { name: "spaces/BBB" }, type: "ADDED_TO_SPACE" },
        }),
        sinkA,
        sinkB,
      });
    } finally {
      unregister();
    }
  });

  it("rejects invalid bearer before attempting to read the body", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: false, reason: "invalid" });
    const { unregister } = registerTwoTargets();

    try {
      const req = createHeaderOnlyWebhookRequest({
        authorization: "Bearer invalid-token",
      });
      const onSpy = vi.spyOn(req, "on");
      const res = await dispatchWebhookRequest(req);
      expect(res.statusCode).toBe(401);
      expect(onSpy).not.toHaveBeenCalledWith("data", expect.any(Function));
    } finally {
      unregister();
    }
  });

  it("supports add-on requests that provide systemIdToken in the body", async () => {
    mockSecondVerifierSuccess();
    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        expectedSink: "B",
        expectedStatus: 200,
        request: createWebhookRequest({
          payload: {
            authorizationEventObject: { systemIdToken: "addon-token" },
            chat: {
              eventTime: "2026-03-02T00:00:00.000Z",
              messagePayload: {
                message: { text: "Hello from add-on" },
                space: { name: "spaces/AAA" },
              },
              user: { displayName: "Test User", name: "users/12345" },
            },
            commonEventObject: { hostApp: "CHAT" },
          },
        }),
        sinkA,
        sinkB,
      });
    } finally {
      unregister();
    }
  });
});
