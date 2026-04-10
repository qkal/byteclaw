import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import {
  installRequestBodyLimitGuard,
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
} from "./http-body.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: (error?: Error) => MockIncomingMessage;
  __unhandledDestroyError?: unknown;
};

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function expectReadPayloadTooLarge(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  maxBytes: number;
}) {
  const req = createMockRequest({
    chunks: params.chunks,
    emitEnd: false,
    headers: params.headers,
  });
  await expect(readRequestBodyWithLimit(req, { maxBytes: params.maxBytes })).rejects.toMatchObject({
    message: "PayloadTooLarge",
  });
  await waitForMicrotaskTurn();
  expect(req.__unhandledDestroyError).toBeUndefined();
}

async function expectGuardPayloadTooLarge(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  maxBytes: number;
  responseFormat?: "json" | "text";
  responseText?: { PAYLOAD_TOO_LARGE?: string };
}) {
  const req = createMockRequest({
    chunks: params.chunks,
    emitEnd: false,
    headers: params.headers,
  });
  const res = createMockServerResponse();
  const guard = installRequestBodyLimitGuard(req, res, {
    maxBytes: params.maxBytes,
    ...(params.responseFormat ? { responseFormat: params.responseFormat } : {}),
    ...(params.responseText ? { responseText: params.responseText } : {}),
  });
  await waitForMicrotaskTurn();
  expect(guard.isTripped()).toBe(true);
  expect(guard.code()).toBe("PAYLOAD_TOO_LARGE");
  expect(res.statusCode).toBe(413);
  expect(req.__unhandledDestroyError).toBeUndefined();
  return { guard, req, res };
}

async function readJsonBody(params: {
  chunks?: string[];
  maxBytes: number;
  emptyObjectOnEmpty?: boolean;
}) {
  const req = createMockRequest({ chunks: params.chunks });
  return await readJsonBodyWithLimit(req, {
    maxBytes: params.maxBytes,
    ...(params.emptyObjectOnEmpty === undefined
      ? {}
      : { emptyObjectOnEmpty: params.emptyObjectOnEmpty }),
  });
}

function createMockRequest(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  emitEnd?: boolean;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.destroyed = false;
  req.headers = params.headers ?? {};
  req.destroy = ((error?: Error) => {
    req.destroyed = true;
    if (error) {
      // Simulate Node's async 'error' emission on destroy(err). If no listener is
      // Present at that time, EventEmitter throws; capture that as "unhandled".
      queueMicrotask(() => {
        try {
          req.emit("error", error);
        } catch (error) {
          req.__unhandledDestroyError = error;
        }
      });
    }
    return req;
  }) as MockIncomingMessage["destroy"];

  if (params.chunks) {
    void Promise.resolve().then(() => {
      for (const chunk of params.chunks ?? []) {
        req.emit("data", Buffer.from(chunk, "utf8"));
        if (req.destroyed) {
          return;
        }
      }
      if (params.emitEnd !== false) {
        req.emit("end");
      }
    });
  }

  return req;
}

describe("http body limits", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads body within max bytes", async () => {
    const req = createMockRequest({ chunks: ['{"ok":true}'] });
    await expect(readRequestBodyWithLimit(req, { maxBytes: 1024 })).resolves.toBe('{"ok":true}');
  });

  it.each([
    {
      chunks: ["x".repeat(512)],
      maxBytes: 64,
      name: "rejects oversized streamed body",
    },
    {
      headers: { "content-length": "9999" },
      maxBytes: 128,
      name: "declared oversized content-length does not emit unhandled error",
    },
  ])("$name", async ({ chunks, headers, maxBytes }) => {
    await expectReadPayloadTooLarge({ chunks, headers, maxBytes });
  });

  it.each([
    {
      assertResult: (result: Awaited<ReturnType<typeof readJsonBody>>) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("INVALID_JSON");
        }
      },
      name: "returns json parse error when body is invalid",
      params: { chunks: ["{bad json"], emptyObjectOnEmpty: false, maxBytes: 1024 },
    },
    {
      assertResult: (result: Awaited<ReturnType<typeof readJsonBody>>) => {
        expect(result).toEqual({ ok: true, value: {} });
      },
      name: "returns empty object for an empty body by default",
      params: { chunks: ["   "], maxBytes: 1024 },
    },
    {
      assertResult: (result: Awaited<ReturnType<typeof readJsonBody>>) => {
        expect(result).toEqual({
          code: "PAYLOAD_TOO_LARGE",
          error: "Payload too large",
          ok: false,
        });
      },
      name: "returns payload-too-large for json body",
      params: { chunks: ["x".repeat(1024)], maxBytes: 10 },
    },
  ])("$name", async ({ params, assertResult }) => {
    const result = await readJsonBody(params);
    assertResult(result);
  });

  it.each([
    {
      expectedBody: '{"error":"Payload too large"}',
      headers: { "content-length": "9999" },
      maxBytes: 128,
      name: "guard rejects oversized declared content-length",
    },
    {
      chunks: ["small", "x".repeat(256)],
      expectedBody: "Payload too large",
      maxBytes: 128,
      name: "guard rejects streamed oversized body",
      responseFormat: "text" as const,
    },
    {
      chunks: ["small", "x".repeat(256)],
      expectedBody: "Too much",
      maxBytes: 128,
      name: "guard uses custom response text for payload-too-large",
      responseFormat: "text" as const,
      responseText: { PAYLOAD_TOO_LARGE: "Too much" },
    },
  ])("$name", async ({ chunks, headers, maxBytes, responseFormat, responseText, expectedBody }) => {
    const { res } = await expectGuardPayloadTooLarge({
      chunks,
      headers,
      maxBytes,
      ...(responseFormat ? { responseFormat } : {}),
      ...(responseText ? { responseText } : {}),
    });
    expect(res.body).toBe(expectedBody);
  });

  it("timeout surfaces typed error when timeoutMs is clamped", async () => {
    const req = createMockRequest({ emitEnd: false });
    const promise = readRequestBodyWithLimit(req, { maxBytes: 128, timeoutMs: 0 });
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT"),
    );
    expect(req.__unhandledDestroyError).toBeUndefined();
  });

  it("guard clamps invalid maxBytes to one byte", async () => {
    const { res } = await expectGuardPayloadTooLarge({
      chunks: ["ab"],
      maxBytes: Number.NaN,
      responseFormat: "text",
    });
    expect(res.body).toBe("Payload too large");
  });

  it("surfaces connection-closed as a typed limit error", async () => {
    const req = createMockRequest({ emitEnd: false });
    const promise = readRequestBodyWithLimit(req, { maxBytes: 128 });
    queueMicrotask(() => req.emit("close"));
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      isRequestBodyLimitError(error, "CONNECTION_CLOSED"),
    );
  });
});
