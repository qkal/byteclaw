import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { createFixedWindowRateLimiter } from "./webhook-memory-guards.js";
import {
  applyBasicWebhookRequestGuards,
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isJsonContentType,
  readJsonWebhookBodyOrReject,
  readWebhookBodyOrReject,
} from "./webhook-request-guards.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
};

function createMockRequest(params: {
  method?: string;
  headers?: Record<string, string>;
  chunks?: string[];
  emitEnd?: boolean;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = params.method ?? "POST";
  req.headers = params.headers ?? {};
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  if (params.chunks) {
    void Promise.resolve().then(() => {
      for (const chunk of params.chunks ?? []) {
        req.emit("data", Buffer.from(chunk, "utf8"));
      }
      if (params.emitEnd !== false) {
        req.emit("end");
      }
    });
  }

  return req;
}

async function readJsonBody(chunks: string[], emptyObjectOnEmpty = false) {
  const req = createMockRequest({ chunks });
  const res = createMockServerResponse();
  return {
    res,
    result: await readJsonWebhookBodyOrReject({
      emptyObjectOnEmpty,
      maxBytes: 1024,
      req,
      res,
    }),
  };
}

async function readRawBody(params: Parameters<typeof createMockRequest>[0], profile?: "pre-auth") {
  const req = createMockRequest(params);
  const res = createMockServerResponse();
  return {
    res,
    result: await readWebhookBodyOrReject({
      profile,
      req,
      res,
    }),
  };
}

describe("isJsonContentType", () => {
  it.each([
    { expected: true, input: "application/json", name: "accepts application/json" },
    {
      expected: true,
      input: "application/cloudevents+json; charset=utf-8",
      name: "accepts +json suffixes",
    },
    { expected: false, input: "text/plain", name: "rejects non-json media types" },
    { expected: false, input: undefined, name: "rejects missing media types" },
  ])("$name", ({ input, expected }) => {
    expect(isJsonContentType(input)).toBe(expected);
  });
});

describe("applyBasicWebhookRequestGuards", () => {
  it("rejects disallowed HTTP methods", () => {
    const req = createMockRequest({ method: "GET" });
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      allowMethods: ["POST"],
      req,
      res,
    });
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("POST");
  });

  it("enforces rate limits", () => {
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      maxTrackedKeys: 10,
      windowMs: 60_000,
    });
    const req1 = createMockRequest({ method: "POST" });
    const res1 = createMockServerResponse();
    const req2 = createMockRequest({ method: "POST" });
    const res2 = createMockServerResponse();
    expect(
      applyBasicWebhookRequestGuards({
        nowMs: 1000,
        rateLimitKey: "k",
        rateLimiter: limiter,
        req: req1,
        res: res1,
      }),
    ).toBe(true);
    expect(
      applyBasicWebhookRequestGuards({
        nowMs: 1001,
        rateLimitKey: "k",
        rateLimiter: limiter,
        req: req2,
        res: res2,
      }),
    ).toBe(false);
    expect(res2.statusCode).toBe(429);
  });

  it.each([
    {
      expectedOk: true,
      expectedStatusCode: 200,
      name: "allows matching JSON requests",
      req: createMockRequest({
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    },
    {
      expectedOk: false,
      expectedStatusCode: 415,
      name: "rejects non-json requests when required",
      req: createMockRequest({
        headers: { "content-type": "text/plain" },
        method: "POST",
      }),
    },
  ])("$name", ({ req, expectedOk, expectedStatusCode }) => {
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      requireJsonContentType: true,
      res,
    });
    expect(ok).toBe(expectedOk);
    expect(res.statusCode).toBe(expectedStatusCode);
  });
});

describe("readJsonWebhookBodyOrReject", () => {
  it.each([
    {
      chunks: ['{"ok":true}'],
      expected: { ok: true, value: { ok: true } },
      expectedBody: undefined,
      expectedStatusCode: 200,
      name: "returns parsed JSON body",
    },
    {
      chunks: ["null"],
      expected: { ok: true, value: null },
      expectedBody: undefined,
      expectedStatusCode: 200,
      name: "preserves valid JSON null payload",
    },
    {
      chunks: ["{bad json"],
      expected: { ok: false },
      expectedBody: "Bad Request",
      expectedStatusCode: 400,
      name: "writes 400 on invalid JSON payload",
    },
  ])("$name", async ({ chunks, expected, expectedStatusCode, expectedBody }) => {
    const { result, res } = await readJsonBody(chunks);
    expect(result).toEqual(expected);
    expect(res.statusCode).toBe(expectedStatusCode);
    expect(res.body).toBe(expectedBody);
  });
});

describe("readWebhookBodyOrReject", () => {
  it("returns raw body contents", async () => {
    const { result } = await readRawBody({ chunks: ["plain text"] });
    expect(result).toEqual({ ok: true, value: "plain text" });
  });

  it("enforces strict pre-auth default body limits", async () => {
    const { result, res } = await readRawBody(
      {
        headers: { "content-length": String(70 * 1024) },
      },
      "pre-auth",
    );
    expect(result).toEqual({ ok: false });
    expect(res.statusCode).toBe(413);
  });
});

describe("beginWebhookRequestPipelineOrReject", () => {
  it("enforces in-flight request limits and releases slots", () => {
    const limiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: 1,
      maxTrackedKeys: 10,
    });

    const first = beginWebhookRequestPipelineOrReject({
      allowMethods: ["POST"],
      inFlightKey: "ip:127.0.0.1",
      inFlightLimiter: limiter,
      req: createMockRequest({ method: "POST" }),
      res: createMockServerResponse(),
    });
    expect(first.ok).toBe(true);

    const secondRes = createMockServerResponse();
    const second = beginWebhookRequestPipelineOrReject({
      allowMethods: ["POST"],
      inFlightKey: "ip:127.0.0.1",
      inFlightLimiter: limiter,
      req: createMockRequest({ method: "POST" }),
      res: secondRes,
    });
    expect(second.ok).toBe(false);
    expect(secondRes.statusCode).toBe(429);

    if (first.ok) {
      first.release();
    }

    const third = beginWebhookRequestPipelineOrReject({
      allowMethods: ["POST"],
      inFlightKey: "ip:127.0.0.1",
      inFlightLimiter: limiter,
      req: createMockRequest({ method: "POST" }),
      res: createMockServerResponse(),
    });
    expect(third.ok).toBe(true);
    if (third.ok) {
      third.release();
    }
  });
});
