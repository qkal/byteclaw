import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  packNpmSpecToArchive,
  resolveArchiveSourcePath,
  withTempDir,
} from "./install-source-utils.js";

const runCommandWithTimeoutMock = vi.fn();
const TEMP_DIR_PREFIX = "openclaw-install-source-utils-";
const tempDirs = createTrackedTempDirs();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

async function createTempDir(prefix: string) {
  return await tempDirs.make(prefix);
}

async function createFixtureDir() {
  return await createTempDir(TEMP_DIR_PREFIX);
}

async function createFixtureFile(params: {
  fileName: string;
  contents: string;
  dir?: string;
}): Promise<{ dir: string; filePath: string }> {
  const dir = params.dir ?? (await createFixtureDir());
  const filePath = path.join(dir, params.fileName);
  await fs.writeFile(filePath, params.contents, "utf8");
  return { dir, filePath };
}

function mockPackCommandResult(params: { stdout: string; stderr?: string; code?: number }) {
  runCommandWithTimeoutMock.mockResolvedValue({
    code: params.code ?? 0,
    killed: false,
    signal: null,
    stderr: params.stderr ?? "",
    stdout: params.stdout,
  });
}

async function runPack(spec: string, cwd: string, timeoutMs = 1000) {
  return await packNpmSpecToArchive({
    cwd,
    spec,
    timeoutMs,
  });
}

async function expectPackFallsBackToDetectedArchive(params: {
  stdout: string;
  expectedMetadata?: Record<string, unknown>;
}) {
  const cwd = await createTempDir("openclaw-install-source-utils-");
  const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
  await fs.writeFile(archivePath, "", "utf8");
  runCommandWithTimeoutMock.mockResolvedValue({
    code: 0,
    killed: false,
    signal: null,
    stderr: "",
    stdout: params.stdout,
  });

  const result = await packNpmSpecToArchive({
    cwd,
    spec: "openclaw-plugin@1.2.3",
    timeoutMs: 5000,
  });

  expect(result).toEqual({
    archivePath,
    metadata: params.expectedMetadata ?? {},
    ok: true,
  });
}

function expectPackError(result: { ok: boolean; error?: string }, expected: string[]): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  for (const part of expected) {
    expect(result.error ?? "").toContain(part);
  }
}

beforeEach(() => {
  runCommandWithTimeoutMock.mockClear();
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("withTempDir", () => {
  it("creates a temp dir and always removes it after callback", async () => {
    let observedDir = "";
    const markerFile = "marker.txt";

    const value = await withTempDir("openclaw-install-source-utils-", async (tmpDir) => {
      observedDir = tmpDir;
      await fs.writeFile(path.join(tmpDir, markerFile), "ok", "utf8");
      await expect(fs.stat(path.join(tmpDir, markerFile))).resolves.toBeDefined();
      return "done";
    });

    expect(value).toBe("done");
    await expect(fs.stat(observedDir)).rejects.toThrow();
  });
});

describe("resolveArchiveSourcePath", () => {
  it.each([
    {
      expected: "archive not found",
      name: "returns not found error for missing archive paths",
      path: async () => "/tmp/does-not-exist-openclaw-archive.tgz",
    },
    {
      expected: "unsupported archive",
      name: "rejects unsupported archive extensions",
      path: async () =>
        (
          await createFixtureFile({
            contents: "not-an-archive",
            fileName: "plugin.txt",
          })
        ).filePath,
    },
  ])("$name", async ({ path: resolvePath, expected }) => {
    expectPackError(await resolveArchiveSourcePath(await resolvePath()), [expected]);
  });

  it.each(["plugin.zip", "plugin.tgz", "plugin.tar.gz"])(
    "accepts supported archive extension %s",
    async (fileName) => {
      const { filePath } = await createFixtureFile({
        contents: "",
        fileName,
      });

      const result = await resolveArchiveSourcePath(filePath);
      expect(result).toEqual({ ok: true, path: filePath });
    },
  );
});

describe("packNpmSpecToArchive", () => {
  it("packs spec and returns archive path using JSON output metadata", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf8");
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          filename: "openclaw-plugin-1.2.3.tgz",
          id: "openclaw-plugin@1.2.3",
          integrity: "sha512-test-integrity",
          name: "openclaw-plugin",
          shasum: "abc123",
          version: "1.2.3",
        },
      ]),
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      archivePath,
      metadata: {
        integrity: "sha512-test-integrity",
        name: "openclaw-plugin",
        resolvedSpec: "openclaw-plugin@1.2.3",
        shasum: "abc123",
        version: "1.2.3",
      },
      ok: true,
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["npm", "pack", "openclaw-plugin@1.2.3", "--ignore-scripts", "--json"],
      expect.objectContaining({
        cwd,
        timeoutMs: 300_000,
      }),
    );
  });

  it("falls back to parsing final stdout line when npm json output is unavailable", async () => {
    const cwd = await createFixtureDir();
    const expectedArchivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(expectedArchivePath, "", "utf8");
    mockPackCommandResult({
      stdout: "npm notice created package\nopenclaw-plugin-1.2.3.tgz\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      archivePath: expectedArchivePath,
      metadata: {},
      ok: true,
    });
  });

  it("returns npm pack error details when command fails", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      code: 1,
      stderr: "registry timeout",
      stdout: "fallback stdout",
    });

    const result = await runPack("bad-spec", cwd, 5000);
    expectPackError(result, ["npm pack failed", "registry timeout"]);
  });

  it.each([
    {
      name: "falls back to archive detected in cwd when npm pack stdout is empty",
      stdout: " \n\n",
    },
    {
      name: "falls back to archive detected in cwd when stdout does not contain a tgz",
      stdout: "npm pack completed successfully\n",
    },
    {
      expectedMetadata: {
        integrity: "sha512-test-integrity",
        name: "openclaw-plugin",
        resolvedSpec: "openclaw-plugin@1.2.3",
        shasum: "abc123",
        version: "1.2.3",
      },
      name: "falls back to cwd archive when logged JSON metadata omits filename",
      stdout:
        'npm notice using cache\n[{"id":"openclaw-plugin@1.2.3","name":"openclaw-plugin","version":"1.2.3","integrity":"sha512-test-integrity","shasum":"abc123"}]\n',
    },
  ])("$name", async ({ stdout, expectedMetadata }) => {
    await expectPackFallsBackToDetectedArchive({ expectedMetadata, stdout });
  });

  it("returns friendly error for 404 (package not on npm)", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      code: 1,
      stderr: "npm error code E404\nnpm error 404  '@openclaw/whatsapp@*' is not in this registry.",
      stdout: "",
    });

    const result = await runPack("@openclaw/whatsapp", cwd);
    expectPackError(result, [
      "Package not found on npm",
      "@openclaw/whatsapp",
      "docs.openclaw.ai/tools/plugin",
    ]);
  });

  it("returns explicit error when npm pack produces no archive name", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: " \n\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd, 5000);

    expect(result).toEqual({
      error: "npm pack produced no archive",
      ok: false,
    });
  });

  it("parses scoped metadata from id-only json output even with npm notice prefix", async () => {
    const cwd = await createFixtureDir();
    await fs.writeFile(path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"), "", "utf8");
    mockPackCommandResult({
      stdout:
        "npm notice creating package\n" +
        JSON.stringify([
          {
            filename: "openclaw-plugin-demo-2.0.0.tgz",
            id: "@openclaw/plugin-demo@2.0.0",
          },
        ]),
    });

    const result = await runPack("@openclaw/plugin-demo@2.0.0", cwd);
    expect(result).toEqual({
      archivePath: path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"),
      metadata: {
        resolvedSpec: "@openclaw/plugin-demo@2.0.0",
      },
      ok: true,
    });
  });

  it("uses stdout fallback error text when stderr is empty", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      code: 1,
      stderr: " ",
      stdout: "network timeout",
    });

    const result = await runPack("bad-spec", cwd);
    expect(result).toEqual({
      error: "npm pack failed: network timeout",
      ok: false,
    });
  });
});
