import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createMockIncomingRequest } from "../../../test/helpers/mock-incoming-request.js";
import { createLineNodeWebhookHandler, readLineWebhookRequestBody } from "./webhook-node.js";
import { createLineWebhookMiddleware } from "./webhook.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

function createRes() {
  const headers: Record<string, string> = {};
  const resObj = {
    body: undefined as unknown,
    end: vi.fn((data?: unknown) => {
      resObj.headersSent = true;
      // Keep payload available for assertions
      resObj.body = data;
    }),
    headersSent: false,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    statusCode: 0,
  };
  const res = resObj as unknown as ServerResponse & { body?: unknown };
  return { headers, res };
}

const SECRET = "secret";

function createMiddlewareRes() {
  const res = {
    headersSent: false,
    json: vi.fn(),
    status: vi.fn(),
  } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function createPostWebhookTestHarness(rawBody: string, secret = "secret") {
  const bot = { handleWebhook: vi.fn(async () => {}) };
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const handler = createLineNodeWebhookHandler({
    bot,
    channelSecret: secret,
    readBody: async () => rawBody,
    runtime,
  });
  return { bot, handler, secret };
}

const runSignedPost = async (params: {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  rawBody: string;
  secret: string;
  res: ServerResponse;
}) =>
  await params.handler(
    {
      headers: { "x-line-signature": sign(params.rawBody, params.secret) },
      method: "POST",
    } as unknown as IncomingMessage,
    params.res,
  );

async function invokeWebhook(params: {
  body: unknown;
  headers?: Record<string, string>;
  onEvents?: ReturnType<typeof vi.fn>;
  autoSign?: boolean;
}) {
  const onEventsMock = params.onEvents ?? vi.fn(async () => {});
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents: onEventsMock as never,
  });

  const headers = { ...params.headers };
  const autoSign = params.autoSign ?? true;
  if (autoSign && !headers["x-line-signature"]) {
    if (typeof params.body === "string") {
      headers["x-line-signature"] = sign(params.body, SECRET);
    } else if (Buffer.isBuffer(params.body)) {
      headers["x-line-signature"] = sign(params.body.toString("utf8"), SECRET);
    }
  }

  const req = {
    body: params.body,
    headers,
  } as any;
  const res = createMiddlewareRes();
  await middleware(req, res, {} as any);
  return { onEvents: onEventsMock, res };
}

async function expectSignedRawBodyWins(params: { rawBody: string | Buffer; signedUserId: string }) {
  const onEvents = vi.fn(async () => {});
  const reqBody = {
    events: [{ source: { userId: "tampered-user" }, type: "message" }],
  };
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents,
  });
  const rawBodyText =
    typeof params.rawBody === "string" ? params.rawBody : params.rawBody.toString("utf8");
  const req = {
    body: reqBody,
    headers: { "x-line-signature": sign(rawBodyText, SECRET) },
    rawBody: params.rawBody,
  } as any;
  const res = createMiddlewareRes();

  await middleware(req, res, {} as any);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(onEvents).toHaveBeenCalledTimes(1);
  const processedBody = (
    onEvents.mock.calls[0] as unknown as [{ events?: { source?: { userId?: string } }[] }]
  )?.[0];
  expect(processedBody?.events?.[0]?.source?.userId).toBe(params.signedUserId);
  expect(processedBody?.events?.[0]?.source?.userId).not.toBe("tampered-user");
}

describe("createLineNodeWebhookHandler", () => {
  it("returns 200 for GET", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const handler = createLineNodeWebhookHandler({
      bot,
      channelSecret: "secret",
      readBody: async () => "",
      runtime,
    });

    const { res } = createRes();
    await handler({ headers: {}, method: "GET" } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("returns 204 for HEAD", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const handler = createLineNodeWebhookHandler({
      bot,
      channelSecret: "secret",
      readBody: async () => "",
      runtime,
    });

    const { res } = createRes();
    await handler({ headers: {}, method: "HEAD" } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it("rejects verification-shaped requests without a signature", async () => {
    const rawBody = JSON.stringify({ events: [] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res, headers } = createRes();
    await handler({ headers: {}, method: "POST" } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(headers["content-type"]).toBe("application/json");
    expect(res.body).toBe(JSON.stringify({ error: "Missing X-Line-Signature header" }));
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("accepts signed verification-shaped requests without dispatching events", async () => {
    const rawBody = JSON.stringify({ events: [] });
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res, headers } = createRes();
    await runSignedPost({ handler, rawBody, res, secret });

    expect(res.statusCode).toBe(200);
    expect(headers["content-type"]).toBe("application/json");
    expect(res.body).toBe(JSON.stringify({ status: "ok" }));
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("returns 405 for non-GET/HEAD/POST methods", async () => {
    const { bot, handler } = createPostWebhookTestHarness(JSON.stringify({ events: [] }));

    const { res, headers } = createRes();
    await handler({ headers: {}, method: "PUT" } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(405);
    expect(headers.allow).toBe("GET, HEAD, POST");
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects missing signature when events are non-empty", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler({ headers: {}, method: "POST" } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects unsigned POST requests before reading the body", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const readBody = vi.fn(async () => JSON.stringify({ events: [{ type: "message" }] }));
    const handler = createLineNodeWebhookHandler({
      bot,
      channelSecret: "secret",
      readBody,
      runtime,
    });

    const { res } = createRes();
    await handler({ headers: {}, method: "POST" } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("uses strict pre-auth limits for signed POST requests", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const readBody = vi.fn(async (_req: IncomingMessage, maxBytes: number, timeoutMs?: number) => {
      expect(maxBytes).toBe(64 * 1024);
      expect(timeoutMs).toBe(5000);
      return rawBody;
    });
    const handler = createLineNodeWebhookHandler({
      bot,
      channelSecret: "secret",
      maxBodyBytes: 1024 * 1024,
      readBody,
      runtime,
    });

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, res, secret: "secret" });

    expect(res.statusCode).toBe(200);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid signature", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler(
      { headers: { "x-line-signature": "bad" }, method: "POST" } as unknown as IncomingMessage,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("accepts valid signature and dispatches events", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, res, secret });

    expect(res.statusCode).toBe(200);
    expect(bot.handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ events: expect.any(Array) }),
    );
  });

  it("releases authenticated requests before event processing completes", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    let releaseAuthenticated!: () => void;
    const bot = {
      handleWebhook: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            releaseAuthenticated = resolve;
          }),
      ),
    };
    const onRequestAuthenticated = vi.fn();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const handler = createLineNodeWebhookHandler({
      bot,
      channelSecret: SECRET,
      onRequestAuthenticated,
      readBody: async () => rawBody,
      runtime,
    });

    const { res } = createRes();
    const request = runSignedPost({ handler, rawBody, res, secret: SECRET });

    await vi.waitFor(() => {
      expect(onRequestAuthenticated).toHaveBeenCalledTimes(1);
      expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
    });

    expect(res.headersSent).toBe(false);
    releaseAuthenticated();
    await request;

    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when event processing fails and does not acknowledge with 200", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { secret } = createPostWebhookTestHarness(rawBody);
    const failingBot = {
      handleWebhook: vi.fn(async () => {
        throw new Error("transient failure");
      }),
    };
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const failingHandler = createLineNodeWebhookHandler({
      bot: failingBot,
      channelSecret: secret,
      readBody: async () => rawBody,
      runtime,
    });

    const { res } = createRes();
    await runSignedPost({ handler: failingHandler, rawBody, res, secret });

    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(failingBot.handleWebhook).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid JSON payload even when signature is valid", async () => {
    const rawBody = "not json";
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, res, secret });

    expect(res.statusCode).toBe(400);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
});

describe("readLineWebhookRequestBody", () => {
  it("reads body within limit", async () => {
    const req = createMockIncomingRequest(['{"events":[{"type":"message"}]}']);
    const body = await readLineWebhookRequestBody(req, 1024);
    expect(body).toContain('"events"');
  });

  it("rejects oversized body", async () => {
    const req = createMockIncomingRequest(["x".repeat(2048)]);
    await expect(readLineWebhookRequestBody(req, 128)).rejects.toThrow("PayloadTooLarge");
  });
});

describe("createLineWebhookMiddleware", () => {
  it.each([
    ["raw string body", JSON.stringify({ events: [{ type: "message" }] })],
    ["raw buffer body", Buffer.from(JSON.stringify({ events: [{ type: "follow" }] }), "utf8")],
  ])("parses JSON from %s", async (_label, body) => {
    const { res, onEvents } = await invokeWebhook({ body });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(onEvents).toHaveBeenCalledWith(expect.objectContaining({ events: expect.any(Array) }));
  });

  it("rejects invalid JSON payloads", async () => {
    const { res, onEvents } = await invokeWebhook({ body: "not json" });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects webhooks with invalid signatures", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [{ type: "message" }] }),
      headers: { "x-line-signature": "invalid-signature" },
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects verification-shaped requests without a signature", async () => {
    const { res, onEvents } = await invokeWebhook({
      autoSign: false,
      body: JSON.stringify({ events: [] }),
      headers: {},
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing X-Line-Signature header" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("accepts signed verification-shaped requests without dispatching events", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects oversized signed payloads before JSON parsing", async () => {
    const largeBody = JSON.stringify({ events: [], payload: "x".repeat(70 * 1024) });
    const { res, onEvents } = await invokeWebhook({ body: largeBody });
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: "Payload too large" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects missing signature when events are non-empty", async () => {
    const { res, onEvents } = await invokeWebhook({
      autoSign: false,
      body: JSON.stringify({ events: [{ type: "message" }] }),
      headers: {},
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing X-Line-Signature header" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects signed requests when raw body is missing", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: { events: [{ type: "message" }] },
      headers: { "x-line-signature": "signed" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing raw request body for signature verification",
    });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("uses the signed raw body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: JSON.stringify({
        events: [{ source: { userId: "signed-user" }, type: "message" }],
      }),
      signedUserId: "signed-user",
    });
  });

  it("uses signed raw buffer body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: Buffer.from(
        JSON.stringify({
          events: [{ source: { userId: "signed-buffer-user" }, type: "message" }],
        }),
        "utf8",
      ),
      signedUserId: "signed-buffer-user",
    });
  });

  it("rejects invalid signed raw JSON even when req.body is a valid object", async () => {
    const onEvents = vi.fn(async () => {});
    const rawBody = "not-json";
    const middleware = createLineWebhookMiddleware({
      channelSecret: SECRET,
      onEvents,
    });

    const req = {
      body: { events: [{ type: "message" }] },
      headers: { "x-line-signature": sign(rawBody, SECRET) },
      rawBody,
    } as any;
    const res = createMiddlewareRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid webhook payload" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("returns 500 when event processing fails and does not acknowledge with 200", async () => {
    const onEvents = vi.fn(async () => {
      throw new Error("boom");
    });
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const middleware = createLineWebhookMiddleware({
      channelSecret: SECRET,
      onEvents,
      runtime,
    });

    const req = {
      body: rawBody,
      headers: { "x-line-signature": sign(rawBody, SECRET) },
    } as any;
    const res = createMiddlewareRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(runtime.error).toHaveBeenCalled();
  });
});
