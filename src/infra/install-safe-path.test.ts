import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  assertCanonicalPathWithinBase,
  packageNameMatchesId,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
  unscopedPackageName,
} from "./install-safe-path.js";

describe("unscopedPackageName", () => {
  it.each([
    { expected: "matrix", value: "@openclaw/matrix" },
    { expected: "matrix", value: " matrix " },
    { expected: "", value: "" },
  ])("normalizes package names for %j", ({ value, expected }) => {
    expect(unscopedPackageName(value)).toBe(expected);
  });
});

describe("packageNameMatchesId", () => {
  it.each([
    { expected: true, id: "matrix", packageName: "@openclaw/matrix" },
    { expected: true, id: "@openclaw/matrix", packageName: "@openclaw/matrix" },
    { expected: false, id: "signal", packageName: "@openclaw/matrix" },
    { expected: false, id: "matrix", packageName: " " },
    { expected: false, id: " ", packageName: "@openclaw/matrix" },
  ])("matches ids for %j", ({ packageName, id, expected }) => {
    expect(packageNameMatchesId(packageName, id)).toBe(expected);
  });
});

describe("safeDirName", () => {
  it.each([
    { expected: "matrix", value: " matrix " },
    { expected: "..__matrix__plugin", value: "../matrix/plugin" },
    { expected: "dir__plugin", value: "dir\\plugin" },
  ])("normalizes install dir names for %j", ({ value, expected }) => {
    expect(safeDirName(value)).toBe(expected);
  });
});

describe("safePathSegmentHashed", () => {
  it("keeps safe names unchanged", () => {
    expect(safePathSegmentHashed("demo-skill")).toBe("demo-skill");
  });

  it("falls back to a hashed skill name for empty or dot-like segments", () => {
    expect(safePathSegmentHashed("   ")).toMatch(/^skill-[a-f0-9]{10}$/);
    expect(safePathSegmentHashed(".")).toMatch(/^skill-[a-f0-9]{10}$/);
    expect(safePathSegmentHashed("..")).toMatch(/^skill-[a-f0-9]{10}$/);
  });

  it("normalizes separators and adds hash suffix", () => {
    const result = safePathSegmentHashed("../../demo/skill");
    expect(result.includes("/")).toBe(false);
    expect(result.includes("\\")).toBe(false);
    expect(result).toMatch(/-[a-f0-9]{10}$/);
  });

  it("hashes long names while staying bounded", () => {
    const long = "a".repeat(100);
    const result = safePathSegmentHashed(long);
    expect(result.length).toBeLessThanOrEqual(61);
    expect(result).toMatch(/-[a-f0-9]{10}$/);
  });
});

describe("resolveSafeInstallDir", () => {
  it("resolves install dirs under the base directory", () => {
    expect(
      resolveSafeInstallDir({
        baseDir: "/tmp/plugins",
        id: "@openclaw/matrix",
        invalidNameMessage: "invalid plugin name",
      }),
    ).toEqual({
      ok: true,
      path: path.join("/tmp/plugins", "@openclaw__matrix"),
    });
  });

  it("rejects ids that resolve to the base directory itself", () => {
    expect(
      resolveSafeInstallDir({
        baseDir: "/tmp/plugins",
        id: "   ",
        invalidNameMessage: "invalid plugin name",
      }),
    ).toEqual({
      error: "invalid plugin name",
      ok: false,
    });
  });
});

describe("assertCanonicalPathWithinBase", () => {
  it("accepts in-base directories", async () => {
    await withTempDir({ prefix: "openclaw-install-safe-" }, async (baseDir) => {
      const candidate = path.join(baseDir, "tools");
      await fs.mkdir(candidate, { recursive: true });
      await expect(
        assertCanonicalPathWithinBase({
          baseDir,
          boundaryLabel: "install directory",
          candidatePath: candidate,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("accepts missing candidate paths when their parent stays in base", async () => {
    await withTempDir({ prefix: "openclaw-install-safe-" }, async (baseDir) => {
      const candidate = path.join(baseDir, "tools", "plugin");
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await expect(
        assertCanonicalPathWithinBase({
          baseDir,
          boundaryLabel: "install directory",
          candidatePath: candidate,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects non-directory base paths", async () => {
    await withTempDir({ prefix: "openclaw-install-safe-" }, async (baseDir) => {
      const baseFile = path.join(baseDir, "not-a-dir");
      await fs.writeFile(baseFile, "nope", "utf8");
      await expect(
        assertCanonicalPathWithinBase({
          baseDir: baseFile,
          boundaryLabel: "install directory",
          candidatePath: path.join(baseFile, "child"),
        }),
      ).rejects.toThrow(/base directory must be a real directory/i);
    });
  });

  it("rejects non-directory candidate paths inside the base", async () => {
    await withTempDir({ prefix: "openclaw-install-safe-" }, async (baseDir) => {
      const candidate = path.join(baseDir, "file.txt");
      await fs.writeFile(candidate, "nope", "utf8");
      await expect(
        assertCanonicalPathWithinBase({
          baseDir,
          boundaryLabel: "install directory",
          candidatePath: candidate,
        }),
      ).rejects.toThrow(/must stay within install directory/i);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked candidate directories that escape the base",
    async () => {
      await withTempDir({ prefix: "openclaw-install-safe-" }, async (baseDir) => {
        await withTempDir({ prefix: "openclaw-install-safe-outside-" }, async (outsideDir) => {
          const linkDir = path.join(baseDir, "alias");
          await fs.symlink(outsideDir, linkDir);
          await expect(
            assertCanonicalPathWithinBase({
              baseDir,
              boundaryLabel: "install directory",
              candidatePath: linkDir,
            }),
          ).rejects.toThrow(/must stay within install directory/i);
        });
      });
    },
  );

  it.runIf(process.platform !== "win32")("rejects symlinked base directories", async () => {
    await withTempDir({ prefix: "openclaw-install-safe-" }, async (parentDir) => {
      const realBaseDir = path.join(parentDir, "real-base");
      const symlinkBaseDir = path.join(parentDir, "base-link");
      await fs.mkdir(realBaseDir, { recursive: true });
      await fs.symlink(realBaseDir, symlinkBaseDir);
      await expect(
        assertCanonicalPathWithinBase({
          baseDir: symlinkBaseDir,
          boundaryLabel: "install directory",
          candidatePath: path.join(symlinkBaseDir, "tool"),
        }),
      ).rejects.toThrow(/base directory must be a real directory/i);
    });
  });
});
