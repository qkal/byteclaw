import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-path.js";

function expectArchivePathError(run: () => void, message: string) {
  expect(run).toThrow(message);
}

describe("archive path helpers", () => {
  it.each([
    { expected: true, value: "C:\\temp\\file.txt" },
    { expected: true, value: "D:/temp/file.txt" },
    { expected: false, value: "tmp/file.txt" },
    { expected: false, value: "/tmp/file.txt" },
  ])("detects Windows drive paths for %j", ({ value, expected }) => {
    expect(isWindowsDrivePath(value)).toBe(expected);
  });

  it.each([
    { expected: "dir/file.txt", raw: "dir\\file.txt" },
    { expected: "dir/file.txt", raw: "dir/file.txt" },
  ])("normalizes archive separators for %j", ({ raw, expected }) => {
    expect(normalizeArchiveEntryPath(raw)).toBe(expected);
  });

  it.each(["", ".", "./"])("accepts empty-like entry paths: %j", (entryPath) => {
    expect(() => validateArchiveEntryPath(entryPath)).not.toThrow();
  });

  it.each([
    {
      entryPath: "../escape.txt",
      message: "archive entry escapes targetDir: ../escape.txt",
      name: "uses custom escape labels in traversal errors",
    },
    {
      entryPath: "C:\\temp\\file.txt",
      message: "archive entry uses a drive path: C:\\temp\\file.txt",
      name: "rejects Windows drive paths",
    },
    {
      entryPath: "/tmp/file.txt",
      message: "archive entry is absolute: /tmp/file.txt",
      name: "rejects absolute paths after normalization",
    },
    {
      entryPath: "\\\\server\\share.txt",
      message: "archive entry is absolute: \\\\server\\share.txt",
      name: "rejects double-slash absolute paths after normalization",
    },
  ])("$name", ({ entryPath, message }) => {
    expectArchivePathError(
      () =>
        validateArchiveEntryPath(entryPath, {
          escapeLabel: "targetDir",
        }),
      message,
    );
  });

  it.each([
    { entryPath: "a/../escape.txt", expected: "../escape.txt", stripComponents: 1 },
    { entryPath: "a//b/file.txt", expected: "b/file.txt", stripComponents: 1 },
    { entryPath: "./", expected: null, stripComponents: 0 },
    { entryPath: "a", expected: null, stripComponents: 3 },
    { entryPath: "dir\\sub\\file.txt", expected: "sub/file.txt", stripComponents: 1 },
  ])("strips archive paths for %j", ({ entryPath, stripComponents, expected }) => {
    expect(stripArchivePath(entryPath, stripComponents)).toBe(expected);
  });

  it("preserves strip-induced traversal for follow-up validation", () => {
    const stripped = stripArchivePath("a/../escape.txt", 1);
    expect(stripped).toBe("../escape.txt");
    expectArchivePathError(
      () =>
        validateArchiveEntryPath(stripped ?? "", {
          escapeLabel: "targetDir",
        }),
      "archive entry escapes targetDir: ../escape.txt",
    );
  });

  const rootDir = path.join(path.sep, "tmp", "archive-root");

  it.each([
    {
      expected: path.resolve(rootDir, "sub/file.txt"),
      name: "keeps resolved output paths inside the root",
      originalPath: "sub/file.txt",
      relPath: "sub/file.txt",
    },
    {
      escapeLabel: "targetDir",
      message: "archive entry escapes targetDir: ../escape.txt",
      name: "rejects output paths that escape the root",
      originalPath: "../escape.txt",
      relPath: "../escape.txt",
    },
  ])("$name", ({ relPath, originalPath, escapeLabel, expected, message }) => {
    if (message) {
      expectArchivePathError(
        () =>
          resolveArchiveOutputPath({
            escapeLabel,
            originalPath,
            relPath,
            rootDir,
          }),
        message,
      );
      return;
    }

    expect(
      resolveArchiveOutputPath({
        originalPath,
        relPath,
        rootDir,
      }),
    ).toBe(expected);
  });
});
