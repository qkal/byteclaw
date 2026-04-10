import { describe, expect, it } from "vitest";
import { DEFAULT_GOOGLE_API_BASE_URL, normalizeGoogleApiBaseUrl } from "./google-api-base-url.js";

describe("normalizeGoogleApiBaseUrl", () => {
  it("defaults to the Gemini v1beta API root", () => {
    expect(normalizeGoogleApiBaseUrl()).toBe(DEFAULT_GOOGLE_API_BASE_URL);
  });

  it.each([
    {
      expected: DEFAULT_GOOGLE_API_BASE_URL,
      value: "https://generativelanguage.googleapis.com",
    },
    {
      expected: DEFAULT_GOOGLE_API_BASE_URL,
      value: "https://generativelanguage.googleapis.com/",
    },
    {
      expected: DEFAULT_GOOGLE_API_BASE_URL,
      value: "https://generativelanguage.googleapis.com/v1beta",
    },
    {
      expected: "https://generativelanguage.googleapis.com/v1",
      value: "https://generativelanguage.googleapis.com/v1",
    },
    {
      expected: "https://proxy.example.com/google/v1beta",
      value: "https://proxy.example.com/google/v1beta/",
    },
    {
      expected: "generativelanguage.googleapis.com",
      value: "generativelanguage.googleapis.com",
    },
  ])("normalizes %s", ({ value, expected }) => {
    expect(normalizeGoogleApiBaseUrl(value)).toBe(expected);
  });
});
