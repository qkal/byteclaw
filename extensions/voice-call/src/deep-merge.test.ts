import { describe, expect, it } from "vitest";
import { deepMergeDefined } from "./deep-merge.js";

describe("deepMergeDefined", () => {
  it("deep merges nested plain objects and preserves base values for undefined overrides", () => {
    expect(
      deepMergeDefined(
        {
          enabled: true,
          provider: { language: "en", voice: "alloy" },
        },
        {
          enabled: undefined,
          provider: { language: undefined, voice: "echo" },
        },
      ),
    ).toEqual({
      enabled: true,
      provider: { language: "en", voice: "echo" },
    });
  });

  it("replaces non-objects directly and blocks dangerous prototype keys", () => {
    expect(deepMergeDefined(["a"], ["b"])).toEqual(["b"]);
    expect(deepMergeDefined("base", undefined)).toBe("base");
    expect(
      deepMergeDefined(
        { safe: { keep: true } },
        {
          __proto__: { polluted: true },
          constructor: { polluted: true },
          prototype: { polluted: true },
          safe: { next: true },
        },
      ),
    ).toEqual({
      safe: { keep: true, next: true },
    });
  });
});
