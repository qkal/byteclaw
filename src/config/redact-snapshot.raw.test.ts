import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "./redact-snapshot.js";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";

describe("replaceSensitiveValuesInRaw", () => {
  it("ignores empty string replacement tokens", () => {
    const raw = '{ "gateway": { "auth": { "token": "" } }, "other": "" }';

    const result = replaceSensitiveValuesInRaw({
      raw,
      redactedSentinel: REDACTED_SENTINEL,
      sensitiveValues: [""],
    });

    expect(result).toBe(raw);
  });

  it("redacts non-empty values while preserving blank strings", () => {
    const raw = '{ "token": "", "secret": "abc123", "other": "" }';

    const result = replaceSensitiveValuesInRaw({
      raw,
      redactedSentinel: REDACTED_SENTINEL,
      sensitiveValues: ["", "abc123"],
    });

    expect(result).toContain('"token": ""');
    expect(result).toContain('"other": ""');
    expect(result).not.toContain("abc123");
    expect(result).toContain(REDACTED_SENTINEL);
  });

  it("replaces longest values first for overlapping matches", () => {
    const raw = '{ "token": "abcd", "prefix": "ab" }';

    const result = replaceSensitiveValuesInRaw({
      raw,
      redactedSentinel: REDACTED_SENTINEL,
      sensitiveValues: ["ab", "abcd", "abcd"],
    });

    expect(result).toBe(`{ "token": "${REDACTED_SENTINEL}", "prefix": "${REDACTED_SENTINEL}" }`);
  });
});
