import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "../infra/errors.js";
import {
  installRequestBodyLimitGuard,
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";

export type WebhookBodyReadProfile = "pre-auth" | "post-auth";

export {
  installRequestBodyLimitGuard,
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";

export const WEBHOOK_BODY_READ_DEFAULTS = Object.freeze({
  postAuth: {
    maxBytes: 1024 * 1024,
    timeoutMs: 30_000,
  },
  preAuth: {
    maxBytes: 64 * 1024,
    timeoutMs: 5000,
  },
});

export const WEBHOOK_IN_FLIGHT_DEFAULTS = Object.freeze({
  maxInFlightPerKey: 8,
  maxTrackedKeys: 4096,
});

export interface WebhookInFlightLimiter {
  tryAcquire: (key: string) => boolean;
  release: (key: string) => void;
  size: () => number;
  clear: () => void;
}

function resolveWebhookBodyReadLimits(params: {
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
}): { maxBytes: number; timeoutMs: number } {
  const defaults =
    params.profile === "pre-auth"
      ? WEBHOOK_BODY_READ_DEFAULTS.preAuth
      : WEBHOOK_BODY_READ_DEFAULTS.postAuth;
  const maxBytes =
    typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) && params.maxBytes > 0
      ? Math.floor(params.maxBytes)
      : defaults.maxBytes;
  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : defaults.timeoutMs;
  return { maxBytes, timeoutMs };
}

function respondWebhookBodyReadError(params: {
  res: ServerResponse;
  code: string;
  invalidMessage?: string;
}): { ok: false } {
  const { res, code, invalidMessage } = params;
  if (code === "PAYLOAD_TOO_LARGE") {
    res.statusCode = 413;
    res.end(requestBodyErrorToText("PAYLOAD_TOO_LARGE"));
    return { ok: false };
  }
  if (code === "REQUEST_BODY_TIMEOUT") {
    res.statusCode = 408;
    res.end(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
    return { ok: false };
  }
  if (code === "CONNECTION_CLOSED") {
    res.statusCode = 400;
    res.end(requestBodyErrorToText("CONNECTION_CLOSED"));
    return { ok: false };
  }
  res.statusCode = 400;
  res.end(invalidMessage ?? "Bad Request");
  return { ok: false };
}

/** Create an in-memory limiter that caps concurrent webhook handlers per key. */
export function createWebhookInFlightLimiter(options?: {
  maxInFlightPerKey?: number;
  maxTrackedKeys?: number;
}): WebhookInFlightLimiter {
  const maxInFlightPerKey = Math.max(
    1,
    Math.floor(options?.maxInFlightPerKey ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey),
  );
  const maxTrackedKeys = Math.max(
    1,
    Math.floor(options?.maxTrackedKeys ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys),
  );
  const active = new Map<string, number>();

  return {
    clear: () => active.clear(),
    release: (key: string) => {
      if (!key) {
        return;
      }
      const current = active.get(key);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        active.delete(key);
        return;
      }
      active.set(key, current - 1);
    },
    size: () => active.size,
    tryAcquire: (key: string) => {
      if (!key) {
        return true;
      }
      const current = active.get(key) ?? 0;
      if (current >= maxInFlightPerKey) {
        return false;
      }
      active.set(key, current + 1);
      pruneMapToMaxSize(active, maxTrackedKeys);
      return true;
    },
  };
}

/** Detect JSON content types, including structured syntax suffixes like `application/ld+json`. */
export function isJsonContentType(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return false;
  }
  const mediaType = normalizeOptionalLowercaseString(first.split(";", 1)[0]);
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

/** Apply method, rate-limit, and content-type guards before a webhook handler reads the body. */
export function applyBasicWebhookRequestGuards(params: {
  req: IncomingMessage;
  res: ServerResponse;
  allowMethods?: readonly string[];
  rateLimiter?: FixedWindowRateLimiter;
  rateLimitKey?: string;
  nowMs?: number;
  requireJsonContentType?: boolean;
}): boolean {
  const allowMethods = params.allowMethods?.length ? params.allowMethods : null;
  if (allowMethods && !allowMethods.includes(params.req.method ?? "")) {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", allowMethods.join(", "));
    params.res.end("Method Not Allowed");
    return false;
  }

  if (
    params.rateLimiter &&
    params.rateLimitKey &&
    params.rateLimiter.isRateLimited(params.rateLimitKey, params.nowMs ?? Date.now())
  ) {
    params.res.statusCode = 429;
    params.res.end("Too Many Requests");
    return false;
  }

  if (
    params.requireJsonContentType &&
    params.req.method === "POST" &&
    !isJsonContentType(params.req.headers["content-type"])
  ) {
    params.res.statusCode = 415;
    params.res.end("Unsupported Media Type");
    return false;
  }

  return true;
}

/** Start the shared webhook request lifecycle and return a release hook for in-flight tracking. */
export function beginWebhookRequestPipelineOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  allowMethods?: readonly string[];
  rateLimiter?: FixedWindowRateLimiter;
  rateLimitKey?: string;
  nowMs?: number;
  requireJsonContentType?: boolean;
  inFlightLimiter?: WebhookInFlightLimiter;
  inFlightKey?: string;
  inFlightLimitStatusCode?: number;
  inFlightLimitMessage?: string;
}): { ok: true; release: () => void } | { ok: false } {
  if (
    !applyBasicWebhookRequestGuards({
      allowMethods: params.allowMethods,
      nowMs: params.nowMs,
      rateLimitKey: params.rateLimitKey,
      rateLimiter: params.rateLimiter,
      req: params.req,
      requireJsonContentType: params.requireJsonContentType,
      res: params.res,
    })
  ) {
    return { ok: false };
  }

  const inFlightKey = params.inFlightKey ?? "";
  const {inFlightLimiter} = params;
  if (inFlightLimiter && inFlightKey && !inFlightLimiter.tryAcquire(inFlightKey)) {
    params.res.statusCode = params.inFlightLimitStatusCode ?? 429;
    params.res.end(params.inFlightLimitMessage ?? "Too Many Requests");
    return { ok: false };
  }

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (inFlightLimiter && inFlightKey) {
        inFlightLimiter.release(inFlightKey);
      }
    },
  };
}

/** Read a webhook request body with bounded size/time limits and translate failures into responses. */
export async function readWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
  invalidBodyMessage?: string;
}): Promise<{ ok: true; value: string } | { ok: false }> {
  const limits = resolveWebhookBodyReadLimits({
    maxBytes: params.maxBytes,
    profile: params.profile,
    timeoutMs: params.timeoutMs,
  });

  try {
    const raw = await readRequestBodyWithLimit(params.req, limits);
    return { ok: true, value: raw };
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return respondWebhookBodyReadError({
        code: error.code,
        invalidMessage: params.invalidBodyMessage,
        res: params.res,
      });
    }
    return respondWebhookBodyReadError({
      code: "INVALID_BODY",
      invalidMessage: params.invalidBodyMessage ?? formatErrorMessage(error),
      res: params.res,
    });
  }
}

/** Read and parse a JSON webhook body, rejecting malformed or oversized payloads consistently. */
export async function readJsonWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
  emptyObjectOnEmpty?: boolean;
  invalidJsonMessage?: string;
}): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const limits = resolveWebhookBodyReadLimits({
    maxBytes: params.maxBytes,
    profile: params.profile,
    timeoutMs: params.timeoutMs,
  });
  const body = await readJsonBodyWithLimit(params.req, {
    emptyObjectOnEmpty: params.emptyObjectOnEmpty,
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
  });
  if (body.ok) {
    return { ok: true, value: body.value };
  }
  return respondWebhookBodyReadError({
    code: body.code,
    invalidMessage: params.invalidJsonMessage,
    res: params.res,
  });
}
