import { describe, expect, it } from "vitest";
import { pickFallbackThinkingLevel } from "./thinking.js";

describe("pickFallbackThinkingLevel", () => {
  it("returns undefined for empty message", () => {
    expect(pickFallbackThinkingLevel({ attempted: new Set(), message: "" })).toBeUndefined();
  });

  it("returns undefined for undefined message", () => {
    expect(pickFallbackThinkingLevel({ attempted: new Set(), message: undefined })).toBeUndefined();
  });

  it("extracts supported values from error message", () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(),
      message: 'Supported values are: "high", "medium"',
    });
    expect(result).toBe("high");
  });

  it("skips already attempted values", () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(["high"]),
      message: 'Supported values are: "high", "medium"',
    });
    expect(result).toBe("medium");
  });

  it('falls back to "off" when error says "not supported" without listing values', () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(),
      message: '400 think value "low" is not supported for this model',
    });
    expect(result).toBe("off");
  });

  it('falls back to "minimal" when the endpoint requires reasoning', () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(["off"]),
      message: "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
    });
    expect(result).toBe("minimal");
  });

  it('returns undefined for reasoning-required errors after "minimal" was attempted', () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(["off", "minimal"]),
      message: "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
    });
    expect(result).toBeUndefined();
  });

  it('falls back to "off" for generic not-supported messages', () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(),
      message: "thinking level not supported by this provider",
    });
    expect(result).toBe("off");
  });

  it('returns undefined if "off" was already attempted', () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(["off"]),
      message: '400 think value "low" is not supported for this model',
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for unrelated error messages", () => {
    const result = pickFallbackThinkingLevel({
      attempted: new Set(),
      message: "rate limit exceeded, please retry after 30 seconds",
    });
    expect(result).toBeUndefined();
  });
});
