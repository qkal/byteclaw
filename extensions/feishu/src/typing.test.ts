import { describe, expect, it } from "vitest";
import { FeishuBackoffError, getBackoffCodeFromResponse, isFeishuBackoffError } from "./typing.js";

describe("isFeishuBackoffError", () => {
  it("returns true for HTTP 429 (AxiosError shape)", () => {
    const err = { response: { data: {}, status: 429 } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for Feishu quota exceeded code 99991403", () => {
    const err = { response: { data: { code: 99_991_403 }, status: 200 } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for Feishu rate limit code 99991400", () => {
    const err = { response: { data: { code: 99_991_400 }, status: 200 } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for SDK error with code 429", () => {
    const err = { code: 429, message: "too many requests" };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for SDK error with top-level code 99991403", () => {
    const err = { code: 99_991_403, message: "quota exceeded" };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns false for other HTTP errors (e.g. 500)", () => {
    const err = { response: { data: {}, status: 500 } };
    expect(isFeishuBackoffError(err)).toBe(false);
  });

  it("returns false for non-rate-limit Feishu codes", () => {
    const err = { response: { data: { code: 99_991_401 }, status: 200 } };
    expect(isFeishuBackoffError(err)).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isFeishuBackoffError(new Error("network timeout"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isFeishuBackoffError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFeishuBackoffError(undefined)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isFeishuBackoffError("429")).toBe(false);
  });

  it("returns true for 429 even without data", () => {
    const err = { response: { status: 429 } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });
});

describe("getBackoffCodeFromResponse", () => {
  it("returns backoff code for response with quota exceeded code", () => {
    const response = { code: 99_991_403, data: null, msg: "quota exceeded" };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns backoff code for response with rate limit code", () => {
    const response = { code: 99_991_400, data: null, msg: "rate limit" };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns backoff code for response with code 429", () => {
    const response = { code: 429, data: null, msg: "too many requests" };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns undefined for successful response (code 0)", () => {
    const response = { code: 0, data: { reaction_id: "r1" }, msg: "success" };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });

  it("returns undefined for other error codes", () => {
    const response = { code: 99_991_401, data: null, msg: "other error" };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(getBackoffCodeFromResponse(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(getBackoffCodeFromResponse(undefined)).toBeUndefined();
  });

  it("returns undefined for response without code field", () => {
    const response = { data: { reaction_id: "r1" } };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });
});

describe("FeishuBackoffError", () => {
  it("is detected by isFeishuBackoffError via .code property", () => {
    const err = new FeishuBackoffError(99_991_403);
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("is detected for rate limit code 99991400", () => {
    const err = new FeishuBackoffError(99_991_400);
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("has correct name and message", () => {
    const err = new FeishuBackoffError(99_991_403);
    expect(err.name).toBe("FeishuBackoffError");
    expect(err.message).toBe("Feishu API backoff: code 99991403");
    expect(err.code).toBe(99_991_403);
  });

  it("is an instance of Error", () => {
    const err = new FeishuBackoffError(99_991_403);
    expect(err instanceof Error).toBe(true);
  });

  it("survives catch-and-rethrow pattern", () => {
    // Simulates the exact pattern in addTypingIndicator/removeTypingIndicator:
    // Thrown inside try, caught by catch, isFeishuBackoffError must match
    let caught: unknown;
    try {
      try {
        throw new FeishuBackoffError(99_991_403);
      } catch (error) {
        if (isFeishuBackoffError(error)) {
          throw error; // Re-thrown — this is the fix
        }
        // Would be silently swallowed with plain Error
        caught = "swallowed";
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FeishuBackoffError);
  });
});
