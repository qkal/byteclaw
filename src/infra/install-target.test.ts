import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";

const fileExistsMock = vi.hoisted(() => vi.fn());
const resolveSafeInstallDirMock = vi.hoisted(() => vi.fn());
const assertCanonicalPathWithinBaseMock = vi.hoisted(() => vi.fn());

vi.mock("./archive.js", () => ({
  fileExists: (...args: unknown[]) => fileExistsMock(...args),
}));

vi.mock("./install-safe-path.js", () => ({
  assertCanonicalPathWithinBase: (...args: unknown[]) => assertCanonicalPathWithinBaseMock(...args),
  resolveSafeInstallDir: (...args: unknown[]) => resolveSafeInstallDirMock(...args),
}));

import { ensureInstallTargetAvailable, resolveCanonicalInstallTarget } from "./install-target.js";

beforeEach(() => {
  fileExistsMock.mockReset();
  resolveSafeInstallDirMock.mockReset();
  assertCanonicalPathWithinBaseMock.mockReset();
});

describe("resolveCanonicalInstallTarget", () => {
  it("creates the base dir and returns early for invalid install ids", async () => {
    await withTempDir({ prefix: "openclaw-install-target-" }, async (root) => {
      const baseDir = path.join(root, "plugins");
      resolveSafeInstallDirMock.mockReturnValueOnce({
        error: "bad id",
        ok: false,
      });

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          boundaryLabel: "plugin dir",
          id: "../oops",
          invalidNameMessage: "bad id",
        }),
      ).resolves.toEqual({ error: "bad id", ok: false });

      await expect(fs.stat(baseDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      expect(assertCanonicalPathWithinBaseMock).not.toHaveBeenCalled();
    });
  });

  it("returns canonical boundary errors for Error and non-Error throws", async () => {
    await withTempDir({ prefix: "openclaw-install-target-" }, async (baseDir) => {
      const targetDir = path.join(baseDir, "demo");
      resolveSafeInstallDirMock.mockReturnValue({
        ok: true,
        path: targetDir,
      });
      assertCanonicalPathWithinBaseMock.mockRejectedValueOnce(new Error("escaped"));
      assertCanonicalPathWithinBaseMock.mockRejectedValueOnce("boom");

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          boundaryLabel: "plugin dir",
          id: "demo",
          invalidNameMessage: "bad id",
        }),
      ).resolves.toEqual({ error: "escaped", ok: false });

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          boundaryLabel: "plugin dir",
          id: "demo",
          invalidNameMessage: "bad id",
        }),
      ).resolves.toEqual({ error: "boom", ok: false });
    });
  });

  it("returns the resolved target path on success", async () => {
    await withTempDir({ prefix: "openclaw-install-target-" }, async (baseDir) => {
      const targetDir = path.join(baseDir, "demo");
      resolveSafeInstallDirMock.mockReturnValueOnce({
        ok: true,
        path: targetDir,
      });

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          boundaryLabel: "plugin dir",
          id: "demo",
          invalidNameMessage: "bad id",
        }),
      ).resolves.toEqual({ ok: true, targetDir });
    });
  });
});

describe("ensureInstallTargetAvailable", () => {
  it("blocks only install mode when the target already exists", async () => {
    fileExistsMock.mockResolvedValueOnce(true);
    fileExistsMock.mockResolvedValueOnce(false);

    await expect(
      ensureInstallTargetAvailable({
        alreadyExistsError: "already there",
        mode: "install",
        targetDir: "/tmp/demo",
      }),
    ).resolves.toEqual({ error: "already there", ok: false });

    await expect(
      ensureInstallTargetAvailable({
        alreadyExistsError: "already there",
        mode: "update",
        targetDir: "/tmp/demo",
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      ensureInstallTargetAvailable({
        alreadyExistsError: "already there",
        mode: "install",
        targetDir: "/tmp/demo",
      }),
    ).resolves.toEqual({ ok: true });
  });
});
