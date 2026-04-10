import { describe, expect, it } from "vitest";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";

describe("sanitizeEnvVars", () => {
  it("keeps normal env vars and blocks obvious credentials", () => {
    const result = sanitizeEnvVars({
      NODE_ENV: "test",
      OPENAI_API_KEY: "sk-live-xxx", // Pragma: allowlist secret
      FOO: "bar",
      GITHUB_TOKEN: "gh-token", // Pragma: allowlist secret
    });

    expect(result.allowed).toEqual({
      FOO: "bar",
      NODE_ENV: "test",
    });
    expect(result.blocked).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "GITHUB_TOKEN"]));
  });

  it("blocks credentials even when suffix pattern matches", () => {
    const result = sanitizeEnvVars({
      MY_SECRET: "def",
      MY_TOKEN: "abc",
      USER: "alice",
    });

    expect(result.allowed).toEqual({ USER: "alice" });
    expect(result.blocked).toEqual(expect.arrayContaining(["MY_TOKEN", "MY_SECRET"]));
  });

  it("adds warnings for suspicious values", () => {
    const base64Like =
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==";
    const result = sanitizeEnvVars({
      NULL: "a\0b",
      SAFE_TEXT: base64Like,
      USER: "alice",
    });

    expect(result.allowed).toEqual({ SAFE_TEXT: base64Like, USER: "alice" });
    expect(result.blocked).toContain("NULL");
    expect(result.warnings).toContain("SAFE_TEXT: Value looks like base64-encoded credential data");
  });

  it("supports strict mode with explicit allowlist", () => {
    const result = sanitizeEnvVars(
      {
        FOO: "bar",
        NODE_ENV: "test",
      },
      { strictMode: true },
    );

    expect(result.allowed).toEqual({ NODE_ENV: "test" });
    expect(result.blocked).toEqual(["FOO"]);
  });

  it("skips undefined values when sanitizing process-style env maps", () => {
    const result = sanitizeEnvVars({
      NODE_ENV: "test",
      OPENAI_API_KEY: undefined,
      OPTIONAL_SECRET: undefined,
    });

    expect(result.allowed).toEqual({ NODE_ENV: "test" });
    expect(result.blocked).toEqual([]);
  });
});
