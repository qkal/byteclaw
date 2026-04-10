import { describe, expect, it, test } from "vitest";
import {
  applyOpenClawManifestInstallCommonFields,
  getFrontmatterString,
  normalizeStringList,
  parseFrontmatterBool,
  parseOpenClawManifestInstallBase,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestInstall,
  resolveOpenClawManifestOs,
  resolveOpenClawManifestRequires,
} from "./frontmatter.js";

describe("shared/frontmatter", () => {
  test("normalizeStringList handles strings, arrays, and non-list values", () => {
    expect(normalizeStringList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(normalizeStringList([" a ", "", "b", 42])).toEqual(["a", "b", "42"]);
    expect(normalizeStringList(null)).toEqual([]);
  });

  test("getFrontmatterString extracts strings only", () => {
    expect(getFrontmatterString({ a: "b" }, "a")).toBe("b");
    expect(getFrontmatterString({ a: 1 }, "a")).toBeUndefined();
  });

  test("parseFrontmatterBool respects explicit values and fallback", () => {
    expect(parseFrontmatterBool("true", false)).toBe(true);
    expect(parseFrontmatterBool("false", true)).toBe(false);
    expect(parseFrontmatterBool(undefined, true)).toBe(true);
    expect(parseFrontmatterBool("maybe", false)).toBe(false);
  });

  test("resolveOpenClawManifestBlock reads current manifest keys and custom metadata fields", () => {
    expect(
      resolveOpenClawManifestBlock({
        frontmatter: {
          metadata: "{ openclaw: { foo: 1, bar: 'baz' } }",
        },
      }),
    ).toEqual({ bar: "baz", foo: 1 });

    expect(
      resolveOpenClawManifestBlock({
        frontmatter: {
          pluginMeta: "{ openclaw: { foo: 2 } }",
        },
        key: "pluginMeta",
      }),
    ).toEqual({ foo: 2 });
  });

  test("resolveOpenClawManifestBlock returns undefined for invalid input", () => {
    expect(resolveOpenClawManifestBlock({ frontmatter: {} })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "not-json5" } }),
    ).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "123" } })).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "[]" } })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "{ nope: { a: 1 } }" } }),
    ).toBeUndefined();
  });

  it("normalizes manifest requirement and os lists", () => {
    expect(
      resolveOpenClawManifestRequires({
        requires: {
          anyBins: [" ffmpeg ", ""],
          bins: "bun, node",
          config: null,
          env: ["OPENCLAW_TOKEN", " OPENCLAW_URL "],
        },
      }),
    ).toEqual({
      anyBins: ["ffmpeg"],
      bins: ["bun", "node"],
      config: [],
      env: ["OPENCLAW_TOKEN", "OPENCLAW_URL"],
    });
    expect(resolveOpenClawManifestRequires({})).toBeUndefined();
    expect(resolveOpenClawManifestOs({ os: [" darwin ", "linux", ""] })).toEqual([
      "darwin",
      "linux",
    ]);
  });

  it("parses and applies install common fields", () => {
    const parsed = parseOpenClawManifestInstallBase(
      {
        bins: [" git ", "git"],
        id: "brew.git",
        label: "Git",
        type: " Brew ",
      },
      ["brew", "npm"],
    );

    expect(parsed).toEqual({
      bins: ["git", "git"],
      id: "brew.git",
      kind: "brew",
      label: "Git",
      raw: {
        bins: [" git ", "git"],
        id: "brew.git",
        label: "Git",
        type: " Brew ",
      },
    });
    expect(parseOpenClawManifestInstallBase({ kind: "bad" }, ["brew"])).toBeUndefined();
    expect(
      applyOpenClawManifestInstallCommonFields<{
        extra: boolean;
        id?: string;
        label?: string;
        bins?: string[];
      }>({ extra: true }, parsed!),
    ).toEqual({
      bins: ["git", "git"],
      extra: true,
      id: "brew.git",
      label: "Git",
    });
  });

  it("prefers explicit kind, ignores invalid common fields, and leaves missing ones untouched", () => {
    const parsed = parseOpenClawManifestInstallBase(
      {
        bins: [" ", ""],
        id: 42,
        kind: " npm ",
        label: null,
        type: "brew",
      },
      ["brew", "npm"],
    );

    expect(parsed).toEqual({
      kind: "npm",
      raw: {
        bins: [" ", ""],
        id: 42,
        kind: " npm ",
        label: null,
        type: "brew",
      },
    });
    expect(
      applyOpenClawManifestInstallCommonFields(
        { bins: ["bun"], id: "keep", label: "Keep" },
        parsed!,
      ),
    ).toEqual({
      bins: ["bun"],
      id: "keep",
      label: "Keep",
    });
  });

  it("maps install entries through the parser and filters rejected specs", () => {
    expect(
      resolveOpenClawManifestInstall(
        {
          install: [{ id: "keep" }, { id: "drop" }, "bad"],
        },
        (entry) => {
          if (
            typeof entry === "object" &&
            entry !== null &&
            (entry as { id?: string }).id === "keep"
          ) {
            return { id: "keep" };
          }
          return undefined;
        },
      ),
    ).toEqual([{ id: "keep" }]);
  });
});
