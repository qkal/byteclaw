import { describe, expect, it, vi } from "vitest";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
  isRevokedProxyError,
} from "./errors.js";
import { withRevokedProxyFallback } from "./revoked-context.js";

describe("msteams errors", () => {
  it("formats unknown errors", () => {
    expect(formatUnknownError("oops")).toBe("oops");
    expect(formatUnknownError(null)).toBe("null");
  });

  it("classifies auth errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 401 }).kind).toBe("auth");
    expect(classifyMSTeamsSendError({ statusCode: 403 }).kind).toBe("auth");
  });

  it("classifies ContentStreamNotAllowed as permanent instead of auth", () => {
    expect(
      classifyMSTeamsSendError({
        response: {
          body: {
            error: {
              code: "ContentStreamNotAllowed",
            },
          },
        },
        statusCode: 403,
      }),
    ).toMatchObject({
      errorCode: "ContentStreamNotAllowed",
      kind: "permanent",
      statusCode: 403,
    });
  });

  it("classifies throttling errors and parses retry-after", () => {
    expect(classifyMSTeamsSendError({ retryAfter: "1.5", statusCode: 429 })).toMatchObject({
      kind: "throttled",
      retryAfterMs: 1500,
      statusCode: 429,
    });
  });

  it("classifies transient errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 503 })).toMatchObject({
      kind: "transient",
      statusCode: 503,
    });
  });

  it("classifies permanent 4xx errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 400 })).toMatchObject({
      kind: "permanent",
      statusCode: 400,
    });
  });

  it("provides actionable hints for common cases", () => {
    expect(formatMSTeamsSendErrorHint({ kind: "auth" })).toContain("msteams");
    expect(formatMSTeamsSendErrorHint({ kind: "throttled" })).toContain("throttled");
    expect(
      formatMSTeamsSendErrorHint({
        errorCode: "ContentStreamNotAllowed",
        kind: "permanent",
      }),
    ).toContain("expired the content stream");
  });

  describe("isRevokedProxyError", () => {
    it("returns true for revoked proxy TypeError", () => {
      expect(
        isRevokedProxyError(new TypeError("Cannot perform 'set' on a proxy that has been revoked")),
      ).toBe(true);
      expect(
        isRevokedProxyError(new TypeError("Cannot perform 'get' on a proxy that has been revoked")),
      ).toBe(true);
    });

    it("returns false for non-TypeError errors", () => {
      expect(isRevokedProxyError(new Error("proxy that has been revoked"))).toBe(false);
    });

    it("returns false for unrelated TypeErrors", () => {
      expect(isRevokedProxyError(new TypeError("undefined is not a function"))).toBe(false);
    });

    it("returns false for non-error values", () => {
      expect(isRevokedProxyError(null)).toBe(false);
      expect(isRevokedProxyError("proxy that has been revoked")).toBe(false);
    });
  });

  describe("withRevokedProxyFallback", () => {
    it("returns primary result when no error occurs", async () => {
      await expect(
        withRevokedProxyFallback({
          onRevoked: async () => "fallback",
          run: async () => "ok",
        }),
      ).resolves.toBe("ok");
    });

    it("uses fallback when proxy-revoked TypeError is thrown", async () => {
      const onRevokedLog = vi.fn();
      await expect(
        withRevokedProxyFallback({
          onRevoked: async () => "fallback",
          onRevokedLog,
          run: async () => {
            throw new TypeError("Cannot perform 'get' on a proxy that has been revoked");
          },
        }),
      ).resolves.toBe("fallback");
      expect(onRevokedLog).toHaveBeenCalledOnce();
    });

    it("rethrows non-revoked errors", async () => {
      const err = Object.assign(new Error("boom"), { statusCode: 500 });
      await expect(
        withRevokedProxyFallback({
          onRevoked: async () => "fallback",
          run: async () => {
            throw err;
          },
        }),
      ).rejects.toBe(err);
    });
  });
});
