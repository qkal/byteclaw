import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { buildRandomTempFilePath, withTempDownloadPath } from "./temp-path.js";

function expectPathInsideTmpRoot(resultPath: string) {
  const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
  const resolved = path.resolve(resultPath);
  const rel = path.relative(tmpRoot, resolved);
  expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
  expect(resultPath).not.toContain("..");
}

describe("buildRandomTempFilePath", () => {
  it.each([
    {
      expectedBasename: "line-media-123-abc.jpg",
      expectedPath: path.join("/tmp", "line-media-123-abc.jpg"),
      input: {
        extension: ".jpg",
        now: 123,
        prefix: "line-media",
        tmpDir: "/tmp",
        uuid: "abc",
      },
      name: "builds deterministic paths when now/uuid are provided",
      verifyInsideTmpRoot: false,
    },
    {
      expectedBasename: "channels-media-123-abc.jpg",
      input: {
        extension: "/../.jpg",
        now: 123,
        prefix: "../../channels/../media",
        uuid: "abc",
      },
      name: "sanitizes prefix and extension to avoid path traversal segments",
      verifyInsideTmpRoot: true,
    },
  ])("$name", ({ input, expectedPath, expectedBasename, verifyInsideTmpRoot }) => {
    const result = buildRandomTempFilePath(input);
    if (expectedPath) {
      expect(result).toBe(expectedPath);
    }
    expect(path.basename(result)).toBe(expectedBasename);
    if (verifyInsideTmpRoot) {
      expectPathInsideTmpRoot(result);
    }
  });
});

describe("withTempDownloadPath", () => {
  it.each([
    {
      expectCleanup: true,
      expectedBasename: undefined,
      input: { prefix: "line-media" },
      name: "creates a temp path under tmp dir and cleans up the temp directory",
    },
    {
      expectCleanup: false,
      expectedBasename: "evil.bin",
      input: { fileName: "../../evil.bin", prefix: "../../channels/../media" },
      name: "sanitizes prefix and fileName",
    },
  ])("$name", async ({ input, expectCleanup, expectedBasename }) => {
    let capturedPath = "";
    await withTempDownloadPath(input, async (tmpPath) => {
      capturedPath = tmpPath;
      if (expectCleanup) {
        await fs.writeFile(tmpPath, "ok");
      }
    });

    expectPathInsideTmpRoot(capturedPath);
    if (expectedBasename) {
      expect(path.basename(capturedPath)).toBe(expectedBasename);
    } else {
      expect(capturedPath).toContain(path.join(resolvePreferredOpenClawTmpDir(), "line-media-"));
    }
    if (expectCleanup) {
      await expect(fs.stat(capturedPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
