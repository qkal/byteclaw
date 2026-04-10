import { describe, expect, it } from "vitest";
import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
  resolveGroupAllowFromSources,
} from "./allow-from.js";

describe("mergeDmAllowFromSources", () => {
  it("merges, trims, and filters empty values", () => {
    expect(
      mergeDmAllowFromSources({
        allowFrom: ["  line:user:abc  ", "", 123],
        storeAllowFrom: ["   ", "telegram:456"],
      }),
    ).toEqual(["line:user:abc", "123", "telegram:456"]);
  });

  it.each([
    {
      expected: ["+1111"],
      input: {
        allowFrom: ["+1111"],
        dmPolicy: "allowlist" as const,
        storeAllowFrom: ["+2222", "+3333"],
      },
      name: "excludes pairing-store entries when dmPolicy is allowlist",
    },
    {
      expected: ["+1111", "+2222"],
      input: {
        allowFrom: ["+1111"],
        dmPolicy: "pairing" as const,
        storeAllowFrom: ["+2222"],
      },
      name: "keeps pairing-store entries for non-allowlist policies",
    },
  ])("$name", ({ input, expected }) => {
    expect(mergeDmAllowFromSources(input)).toEqual(expected);
  });
});

describe("resolveGroupAllowFromSources", () => {
  it("prefers explicit group allowlist", () => {
    expect(
      resolveGroupAllowFromSources({
        allowFrom: ["owner"],
        groupAllowFrom: ["group-owner", " group-admin "],
      }),
    ).toEqual(["group-owner", "group-admin"]);
  });

  it("falls back to DM allowlist when group allowlist is unset/empty", () => {
    expect(
      resolveGroupAllowFromSources({
        allowFrom: [" owner ", "", "owner2"],
        groupAllowFrom: [],
      }),
    ).toEqual(["owner", "owner2"]);
  });

  it("can disable fallback to DM allowlist", () => {
    expect(
      resolveGroupAllowFromSources({
        allowFrom: ["owner", "owner2"],
        fallbackToAllowFrom: false,
        groupAllowFrom: [],
      }),
    ).toEqual([]);
  });
});

describe("firstDefined", () => {
  it("returns the first non-undefined value", () => {
    expect(firstDefined(undefined, undefined, "x", "y")).toBe("x");
    expect(firstDefined(undefined, 0, 1)).toBe(0);
  });
});

describe("isSenderIdAllowed", () => {
  it("supports per-channel empty-list defaults and wildcard/id matches", () => {
    expect(
      isSenderIdAllowed(
        {
          entries: [],
          hasEntries: false,
          hasWildcard: false,
        },
        "123",
        true,
      ),
    ).toBe(true);
    expect(
      isSenderIdAllowed(
        {
          entries: [],
          hasEntries: false,
          hasWildcard: false,
        },
        "123",
        false,
      ),
    ).toBe(false);
    expect(
      isSenderIdAllowed(
        {
          entries: ["111", "222"],
          hasEntries: true,
          hasWildcard: true,
        },
        undefined,
        false,
      ),
    ).toBe(true);
    expect(
      isSenderIdAllowed(
        {
          entries: ["111", "222"],
          hasEntries: true,
          hasWildcard: false,
        },
        "222",
        false,
      ),
    ).toBe(true);
  });
});
