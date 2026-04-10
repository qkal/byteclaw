import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  CircularIncludeError,
  ConfigIncludeError,
  type IncludeResolver,
  MAX_INCLUDE_FILE_BYTES,
  deepMerge,
  resolveConfigIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const ETC_OPENCLAW_DIR = path.join(ROOT_DIR, "etc", "openclaw");
const SHARED_DIR = path.join(ROOT_DIR, "shared");

const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

function etcOpenClawPath(...parts: string[]) {
  return path.join(ETC_OPENCLAW_DIR, ...parts);
}

function sharedPath(...parts: string[]) {
  return path.join(SHARED_DIR, ...parts);
}

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    parseJson: JSON.parse,
    readFile: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
  };
}

function resolve(obj: unknown, files: Record<string, unknown> = {}, basePath = DEFAULT_BASE_PATH) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

function expectResolveIncludeError(
  run: () => unknown,
  expectedPattern?: RegExp,
): ConfigIncludeError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigIncludeError);
  if (expectedPattern) {
    expect((thrown as Error).message).toMatch(expectedPattern);
  }
  return thrown as ConfigIncludeError;
}

describe("resolveConfigIncludes", () => {
  it.each([
    { expected: "hello", name: "string", value: "hello" },
    { expected: 42, name: "number", value: 42 },
    { expected: true, name: "boolean", value: true },
    { expected: null, name: "null", value: null },
    { expected: [1, 2, { a: 1 }], name: "array", value: [1, 2, { a: 1 }] },
    {
      expected: { foo: "bar", nested: { x: 1 } },
      name: "nested object",
      value: { foo: "bar", nested: { x: 1 } },
    },
  ] as const)("passes through non-include $name values unchanged", ({ value, expected }) => {
    expect(resolve(value)).toEqual(expected);
  });

  it("rejects absolute path outside config directory (CWE-22)", () => {
    const absolute = etcOpenClawPath("agents.json");
    const files = { [absolute]: { list: [{ id: "main" }] } };
    const obj = { agents: { $include: absolute } };
    expectResolveIncludeError(() => resolve(obj, files), /escapes config directory/);
  });

  it.each([
    {
      expected: {
        agents: { list: [{ id: "main" }] },
      },
      files: { [configPath("agents.json")]: { list: [{ id: "main" }] } },
      name: "single file include",
      obj: { agents: { $include: "./agents.json" } },
    },
    {
      expected: {
        broadcast: {
          "group-a": ["agent1"],
          "group-b": ["agent2"],
        },
      },
      files: {
        [configPath("a.json")]: { "group-a": ["agent1"] },
        [configPath("b.json")]: { "group-b": ["agent2"] },
      },
      name: "array include deep merge",
      obj: { broadcast: { $include: ["./a.json", "./b.json"] } },
    },
    {
      expected: {
        agents: {
          defaults: { workspace: "~/a" },
          list: [{ id: "main" }],
        },
      },
      files: {
        [configPath("a.json")]: { agents: { defaults: { workspace: "~/a" } } },
        [configPath("b.json")]: { agents: { list: [{ id: "main" }] } },
      },
      name: "array include overlapping keys",
      obj: { $include: ["./a.json", "./b.json"] },
    },
  ] as const)("resolves include merges: $name", ({ obj, files, expected }) => {
    expect(resolve(obj, files)).toEqual(expected);
  });

  it.each([
    {
      expected: { a: 1, b: 2, c: 3 },
      name: "adds sibling keys after include",
      obj: { $include: "./base.json", c: 3 },
    },
    {
      expected: { a: 1, b: 99 },
      name: "lets siblings override included keys",
      obj: { $include: "./base.json", b: 99 },
    },
  ] as const)("merges include content with sibling keys: $name", ({ obj, expected }) => {
    const files = { [configPath("base.json")]: { a: 1, b: 2 } };
    expect(resolve(obj, files)).toEqual(expected);
  });

  it.each([
    { includeFile: "list.json", included: ["a", "b"] },
    { includeFile: "value.json", included: "hello" },
  ] as const)(
    "throws when sibling keys are used with non-object include $includeFile",
    ({ includeFile, included }) => {
      const files = { [configPath(includeFile)]: included };
      const obj = { $include: `./${includeFile}`, extra: true };
      expectResolveIncludeError(
        () => resolve(obj, files),
        /Sibling keys require included content to be an object/,
      );
    },
  );

  it("resolves nested includes", () => {
    const files = {
      [configPath("level1.json")]: { nested: { $include: "./level2.json" } },
      [configPath("level2.json")]: { deep: "value" },
    };
    const obj = { $include: "./level1.json" };
    expect(resolve(obj, files)).toEqual({
      nested: { deep: "value" },
    });
  });

  it.each([
    {
      name: "read failures",
      pattern: /Failed to read include file/,
      run: () => resolve({ $include: "./missing.json" }),
    },
    {
      name: "parse failures",
      pattern: /Failed to parse include file/,
      run: () =>
        resolveConfigIncludes({ $include: "./bad.json" }, DEFAULT_BASE_PATH, {
          parseJson: JSON.parse,
          readFile: () => "{ invalid json }",
        }),
    },
  ] as const)("surfaces include $name", ({ run, pattern }) => {
    expectResolveIncludeError(run, pattern);
  });

  it("throws CircularIncludeError for circular includes", () => {
    const aPath = configPath("a.json");
    const bPath = configPath("b.json");
    const resolver: IncludeResolver = {
      parseJson: JSON.parse,
      readFile: (filePath: string) => {
        if (filePath === aPath) {
          return JSON.stringify({ $include: "./b.json" });
        }
        if (filePath === bPath) {
          return JSON.stringify({ $include: "./a.json" });
        }
        throw new Error(`Unknown file: ${filePath}`);
      },
    };
    const obj = { $include: "./a.json" };
    try {
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver);
      throw new Error("expected circular include error");
    } catch (error) {
      expect(error).toBeInstanceOf(CircularIncludeError);
      const circular = error as CircularIncludeError;
      expect(circular.chain).toEqual(expect.arrayContaining([DEFAULT_BASE_PATH, aPath, bPath]));
      expect(circular.message).toMatch(/Circular include detected/);
      expect(circular.message).toContain("a.json");
      expect(circular.message).toContain("b.json");
    }
  });

  it.each([
    {
      expectedPattern: /expected string or array/,
      name: "rejects scalar include value",
      obj: { $include: 123 },
    },
    {
      expectedPattern: /expected string, got number/,
      name: "rejects number in include array",
      obj: { $include: ["./valid.json", 123] },
    },
    {
      expectedPattern: /expected string, got object/,
      name: "rejects null in include array",
      obj: { $include: ["./valid.json", null] },
    },
    {
      expectedPattern: /expected string, got boolean/,
      name: "rejects boolean in include array",
      obj: { $include: ["./valid.json", false] },
    },
  ] as const)("throws on invalid include value/item types: $name", ({ obj, expectedPattern }) => {
    const files = { [configPath("valid.json")]: { valid: true } };
    expectResolveIncludeError(() => resolve(obj, files), expectedPattern);
  });

  it("respects max depth limit", () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      files[configPath(`level${i}.json`)] = {
        $include: `./level${i + 1}.json`,
      };
    }
    files[configPath("level15.json")] = { done: true };

    const obj = { $include: "./level0.json" };
    expectResolveIncludeError(() => resolve(obj, files), /Maximum include depth/);
  });

  it("allows depth 10 but rejects depth 11", () => {
    const okFiles: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) {
      okFiles[configPath(`ok${i}.json`)] = { $include: `./ok${i + 1}.json` };
    }
    okFiles[configPath("ok9.json")] = { done: true };
    expect(resolve({ $include: "./ok0.json" }, okFiles)).toEqual({
      done: true,
    });

    const failFiles: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      failFiles[configPath(`fail${i}.json`)] = {
        $include: `./fail${i + 1}.json`,
      };
    }
    failFiles[configPath("fail10.json")] = { done: true };
    expectResolveIncludeError(
      () => resolve({ $include: "./fail0.json" }, failFiles),
      /Maximum include depth/,
    );
  });

  it.each([
    {
      expected: {
        agent: { id: "mueller" },
      },
      files: {
        [configPath("clients", "mueller", "agents.json")]: { id: "mueller" },
      },
      name: "resolves nested relative file path",
      obj: { agent: { $include: "./clients/mueller/agents.json" } },
    },
    {
      expected: {
        nested: { a: 1, b: 9 },
      },
      files: {
        [configPath("base.json")]: { nested: { $include: "./nested.json" } },
        [configPath("nested.json")]: { a: 1, b: 2 },
      },
      name: "preserves nested override ordering",
      obj: { $include: "./base.json", nested: { b: 9 } },
    },
  ] as const)(
    "handles relative paths and nested include ordering: $name",
    ({ obj, files, expected }) => {
      expect(resolve(obj, files)).toEqual(expected);
    },
  );

  it("enforces traversal boundaries while allowing safe nested-parent paths", () => {
    expectResolveIncludeError(
      () =>
        resolve(
          { $include: "../../shared/common.json" },
          { [sharedPath("common.json")]: { shared: true } },
          configPath("sub", "openclaw.json"),
        ),
      /escapes config directory/,
    );

    expect(
      resolve(
        { $include: "./sub/child.json" },
        {
          [configPath("sub", "child.json")]: { $include: "../shared/common.json" },
          [configPath("shared", "common.json")]: { shared: true },
        },
      ),
    ).toEqual({
      shared: true,
    });
  });
});

describe("real-world config patterns", () => {
  it.each([
    {
      expected: {
        agents: [
          { id: "mueller-screenshot", workspace: "~/clients/mueller/screenshot" },
          { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
          { id: "schmidt-screenshot", workspace: "~/clients/schmidt/screenshot" },
        ],
        broadcast: {
          "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
          "group-schmidt": ["schmidt-screenshot"],
        },
        gateway: { port: 18_789 },
      },
      files: {
        [configPath("clients", "mueller.json")]: {
          agents: [
            {
              id: "mueller-screenshot",
              workspace: "~/clients/mueller/screenshot",
            },
            {
              id: "mueller-transcribe",
              workspace: "~/clients/mueller/transcribe",
            },
          ],
          broadcast: {
            "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
          },
        },
        [configPath("clients", "schmidt.json")]: {
          agents: [
            {
              id: "schmidt-screenshot",
              workspace: "~/clients/schmidt/screenshot",
            },
          ],
          broadcast: { "group-schmidt": ["schmidt-screenshot"] },
        },
      },
      name: "per-client agent includes",
      obj: {
        $include: ["./clients/mueller.json", "./clients/schmidt.json"],
        gateway: { port: 18_789 },
      },
    },
    {
      expected: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        channels: { whatsapp: { allowFrom: ["+49123"], dmPolicy: "pairing" } },
        gateway: { bind: "loopback", port: 18_789 },
      },
      files: {
        [configPath("gateway.json")]: {
          gateway: { bind: "loopback", port: 18789 },
        },
        [configPath("channels", "whatsapp.json")]: {
          channels: { whatsapp: { allowFrom: ["+49123"], dmPolicy: "pairing" } },
        },
        [configPath("agents", "defaults.json")]: {
          agents: { defaults: { sandbox: { mode: "all" } } },
        },
      },
      name: "modular config structure",
      obj: {
        $include: ["./gateway.json", "./channels/whatsapp.json", "./agents/defaults.json"],
      },
    },
  ] as const)("supports common modular include layouts: $name", ({ obj, files, expected }) => {
    expect(resolve(obj, files)).toEqual(expected);
  });
});
describe("security: path traversal protection (CWE-22)", () => {
  function expectRejectedTraversalPaths(
    cases: readonly { includePath: string; expectEscapesMessage: boolean }[],
  ) {
    for (const { includePath, expectEscapesMessage } of cases) {
      const obj = { $include: includePath };
      expect(() => resolve(obj, {}), includePath).toThrow(ConfigIncludeError);
      if (expectEscapesMessage) {
        expect(() => resolve(obj, {}), includePath).toThrow(/escapes config directory/);
      }
    }
  }

  describe("absolute path attacks", () => {
    it("rejects absolute path attack variants", () => {
      const cases = [
        { expectEscapesMessage: true, includePath: "/etc/passwd" },
        { expectEscapesMessage: true, includePath: "/etc/shadow" },
        { expectEscapesMessage: false, includePath: `${process.env.HOME}/.ssh/id_rsa` },
        { expectEscapesMessage: false, includePath: "/tmp/malicious.json" },
        { expectEscapesMessage: false, includePath: "/" },
      ] as const;
      expectRejectedTraversalPaths(cases);
    });
  });

  describe("relative traversal attacks", () => {
    it("rejects relative traversal path variants", () => {
      const cases = [
        { expectEscapesMessage: true, includePath: "../../etc/passwd" },
        { expectEscapesMessage: false, includePath: "../../../etc/shadow" },
        { expectEscapesMessage: false, includePath: "../../../../../../../../etc/passwd" },
        { expectEscapesMessage: false, includePath: "../sibling-dir/secret.json" },
        { expectEscapesMessage: false, includePath: "/config/../../../etc/passwd" },
      ] as const;
      expectRejectedTraversalPaths(cases);
    });
  });

  describe("legitimate includes (should work)", () => {
    it.each([
      {
        expected: { key: "value" },
        files: { [configPath("sub.json")]: { key: "value" } },
        includePath: "./sub.json",
        name: "same-directory with ./ prefix",
      },
      {
        expected: { key: "value" },
        files: { [configPath("sub.json")]: { key: "value" } },
        includePath: "sub.json",
        name: "same-directory without ./ prefix",
      },
      {
        expected: { nested: true },
        files: { [configPath("sub", "nested.json")]: { nested: true } },
        includePath: "./sub/nested.json",
        name: "subdirectory",
      },
      {
        expected: { deep: true },
        files: { [configPath("a", "b", "c", "deep.json")]: { deep: true } },
        includePath: "./a/b/c/deep.json",
        name: "deep subdirectory",
      },
    ] as const)(
      "allows legitimate include path under config root: $name",
      ({ includePath, files, expected }) => {
        const obj = { $include: includePath };
        expect(resolve(obj, files)).toEqual(expected);
      },
    );

    // Note: Upward traversal from nested configs is restricted for security.
    // Each config file can only include files from its own directory and subdirectories.
    // This prevents potential path traversal attacks even in complex nested scenarios.
  });

  describe("error properties", () => {
    it.each([
      {
        expectedMessageIncludes: ["escapes config directory", "/etc/passwd"],
        includePath: "/etc/passwd",
      },
      {
        expectedMessageIncludes: ["/etc/shadow"],
        includePath: "/etc/shadow",
      },
      {
        expectedMessageIncludes: ["escapes config directory", "../../etc/passwd"],
        includePath: "../../etc/passwd",
      },
    ] as const)(
      "preserves error type/path/message details for $includePath",
      ({ includePath, expectedMessageIncludes }) => {
        const obj = { $include: includePath };
        try {
          resolve(obj, {});
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error, includePath).toBeInstanceOf(ConfigIncludeError);
          expect(error, includePath).toHaveProperty("name", "ConfigIncludeError");
          expect((error as ConfigIncludeError).includePath, includePath).toBe(includePath);
          for (const messagePart of expectedMessageIncludes) {
            expect((error as Error).message, `${includePath}: ${messagePart}`).toContain(messagePart);
          }
        }
      },
    );
  });

  describe("array includes with malicious paths", () => {
    it.each([
      {
        files: { [configPath("good.json")]: { good: true } },
        includePaths: ["./good.json", "/etc/passwd"],
        name: "one malicious path",
      },
      {
        files: {},
        includePaths: ["/etc/passwd", "/etc/shadow"],
        name: "multiple malicious paths",
      },
    ] as const)("rejects arrays with malicious include paths: $name", ({ includePaths, files }) => {
      const obj = { $include: includePaths };
      expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    });

    it("allows array with all legitimate paths", () => {
      const files = {
        [configPath("a.json")]: { a: 1 },
        [configPath("b.json")]: { b: 2 },
      };
      const obj = { $include: ["./a.json", "./b.json"] };
      expect(resolve(obj, files)).toEqual({ a: 1, b: 2 });
    });
  });

  describe("prototype pollution protection", () => {
    it("blocks prototype pollution vectors in shallow and nested merges", () => {
      const cases = [
        {
          base: {},
          expected: {},
          incoming: JSON.parse('{"__proto__":{"polluted":true}}'),
        },
        {
          base: { safe: 1 },
          expected: { normal: 3, safe: 1 },
          incoming: { constructor: { y: 2 }, normal: 3, prototype: { x: 1 } },
        },
        {
          base: { nested: { a: 1 } },
          expected: { nested: { a: 1 } },
          incoming: { nested: JSON.parse('{"__proto__":{"polluted":true}}') },
        },
      ] as const;

      for (const { base, incoming, expected } of cases) {
        const result = deepMerge(base, incoming);
        expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
        expect(result).toEqual(expected);
      }
    });
  });

  describe("edge cases", () => {
    it.each([
      { expectedError: undefined, includePath: "./file\x00.json" },
      { expectedError: ConfigIncludeError, includePath: "//etc/passwd" },
    ] as const)("rejects malformed include path $includePath", ({ includePath, expectedError }) => {
      const obj = { $include: includePath };
      if (expectedError) {
        expectResolveIncludeError(() => resolve(obj, {}));
        return;
      }
      // Path with null byte should be rejected or handled safely.
      expect(() => resolve(obj, {}), includePath).toThrow();
    });

    it("allows child include when config is at filesystem root", () => {
      const rootConfigPath = path.join(path.parse(process.cwd()).root, "test.json");
      const childPath = path.join(path.parse(process.cwd()).root, "child.json");
      const files = { [childPath]: { root: true } };
      const obj = { $include: childPath };
      expect(resolve(obj, files, rootConfigPath)).toEqual({ root: true });
    });

    it("allows include files when the config root path is a symlink", async () => {
      await withTempDir({ prefix: "openclaw-includes-symlink-" }, async (tempRoot) => {
        const realRoot = path.join(tempRoot, "real");
        const linkRoot = path.join(tempRoot, "link");
        await fs.mkdir(path.join(realRoot, "includes"), { recursive: true });
        await fs.writeFile(
          path.join(realRoot, "includes", "extra.json5"),
          "{ logging: { redactSensitive: 'tools' } }\n",
          "utf8",
        );
        await fs.symlink(realRoot, linkRoot, process.platform === "win32" ? "junction" : undefined);

        const result = resolveConfigIncludes(
          { $include: "./includes/extra.json5" },
          path.join(linkRoot, "openclaw.json"),
        );
        expect(result).toEqual({ logging: { redactSensitive: "tools" } });
      });
    });

    it("rejects include files that are hardlinked aliases", async () => {
      if (process.platform === "win32") {
        return;
      }
      await withTempDir({ prefix: "openclaw-includes-hardlink-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        const outsideDir = path.join(tempRoot, "outside");
        await fs.mkdir(configDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        const includePath = path.join(configDir, "extra.json5");
        const outsidePath = path.join(outsideDir, "secret.json5");
        await fs.writeFile(outsidePath, '{"logging":{"redactSensitive":"tools"}}\n', "utf8");
        try {
          await fs.link(outsidePath, includePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw error;
        }

        expect(() =>
          resolveConfigIncludes(
            { $include: "./extra.json5" },
            path.join(configDir, "openclaw.json"),
          ),
        ).toThrow(/security checks|hardlink/i);
      });
    });

    it("rejects oversized include files", async () => {
      await withTempDir({ prefix: "openclaw-includes-big-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        await fs.mkdir(configDir, { recursive: true });
        const includePath = path.join(configDir, "big.json5");
        const payload = "a".repeat(MAX_INCLUDE_FILE_BYTES + 1);
        await fs.writeFile(includePath, `{"blob":"${payload}"}`, "utf8");

        expect(() =>
          resolveConfigIncludes({ $include: "./big.json5" }, path.join(configDir, "openclaw.json")),
        ).toThrow(/security checks|max/i);
      });
    });
  });
});
