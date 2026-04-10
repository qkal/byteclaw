import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  checkDepsStatus,
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmLatestVersion,
  fetchNpmPackageTargetStatus,
  fetchNpmTagVersion,
  formatGitInstallLabel,
  resolveNpmChannelTag,
} from "./update-check.js";

describe("compareSemverStrings", () => {
  it("handles stable and prerelease precedence for both legacy and beta formats", () => {
    expect(compareSemverStrings("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverStrings("v1.0.0", "1.0.0")).toBe(0);

    expect(compareSemverStrings("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);

    expect(compareSemverStrings("1.0.0-2", "1.0.0-1")).toBe(1);
    expect(compareSemverStrings("1.0.0-1", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.0.0.beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0", "1.0.0.beta.1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("resolveNpmChannelTag", () => {
  let versionByTag: Record<string, string | null>;

  beforeEach(() => {
    versionByTag = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
        const tag = decodeURIComponent(url.split("/").pop() ?? "");
        const version = versionByTag[tag] ?? null;
        return {
          json: async () => ({
            engines: version != null ? { node: ">=22.14.0" } : undefined,
            version,
          }),
          ok: version != null,
          status: version != null ? 200 : 404,
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });

  it("falls back to latest when beta has same base as stable", async () => {
    versionByTag.beta = "1.0.1-beta.2";
    versionByTag.latest = "1.0.1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1" });
  });

  it("keeps non-beta channels unchanged", async () => {
    versionByTag.latest = "1.0.3";

    await expect(resolveNpmChannelTag({ channel: "stable", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.3",
    });
  });

  it("exposes tag fetch helpers for success and http failures", async () => {
    versionByTag.latest = "1.0.4";

    await expect(
      fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 }),
    ).resolves.toEqual({
      nodeEngine: ">=22.14.0",
      target: "latest",
      version: "1.0.4",
    });
    await expect(fetchNpmTagVersion({ tag: "latest", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.4",
    });
    await expect(fetchNpmLatestVersion({ timeoutMs: 1000 })).resolves.toEqual({
      error: undefined,
      latestVersion: "1.0.4",
    });
    await expect(fetchNpmTagVersion({ tag: "beta", timeoutMs: 1000 })).resolves.toEqual({
      error: "HTTP 404",
      tag: "beta",
      version: null,
    });
  });
});

describe("formatGitInstallLabel", () => {
  it("formats branch, detached tag, and non-git installs", () => {
    expect(
      formatGitInstallLabel({
        git: {
          ahead: 0,
          behind: 0,
          branch: "main",
          dirty: false,
          fetchOk: true,
          root: "/repo",
          sha: "1234567890abcdef",
          tag: null,
          upstream: "origin/main",
        },
        installKind: "git",
        packageManager: "pnpm",
        root: "/repo",
      }),
    ).toBe("main · @ 12345678");

    expect(
      formatGitInstallLabel({
        git: {
          ahead: 0,
          behind: 0,
          branch: "HEAD",
          dirty: false,
          fetchOk: null,
          root: "/repo",
          sha: "abcdef1234567890",
          tag: "v1.2.3",
          upstream: null,
        },
        installKind: "git",
        packageManager: "pnpm",
        root: "/repo",
      }),
    ).toBe("detached · tag v1.2.3 · @ abcdef12");

    expect(
      formatGitInstallLabel({
        installKind: "package",
        packageManager: "pnpm",
        root: null,
      }),
    ).toBeNull();
  });
});

describe("checkDepsStatus", () => {
  it("reports unknown, missing, stale, and ok states from lockfile markers", async () => {
    await withTempDir({ prefix: "openclaw-update-check-" }, async (base) => {
      await expect(checkDepsStatus({ manager: "unknown", root: base })).resolves.toEqual({
        lockfilePath: null,
        manager: "unknown",
        markerPath: null,
        reason: "unknown package manager",
        status: "unknown",
      });

      await fs.writeFile(path.join(base, "pnpm-lock.yaml"), "lock", "utf8");
      await expect(checkDepsStatus({ manager: "pnpm", root: base })).resolves.toMatchObject({
        manager: "pnpm",
        reason: "node_modules marker missing",
        status: "missing",
      });

      const markerPath = path.join(base, "node_modules", ".modules.yaml");
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, "marker", "utf8");
      const staleDate = new Date(Date.now() - 10_000);
      const freshDate = new Date();
      await fs.utimes(markerPath, staleDate, staleDate);
      await fs.utimes(path.join(base, "pnpm-lock.yaml"), freshDate, freshDate);

      await expect(checkDepsStatus({ manager: "pnpm", root: base })).resolves.toMatchObject({
        manager: "pnpm",
        reason: "lockfile newer than install marker",
        status: "stale",
      });

      const newerMarker = new Date(Date.now() + 2000);
      await fs.utimes(markerPath, newerMarker, newerMarker);
      await expect(checkDepsStatus({ manager: "pnpm", root: base })).resolves.toMatchObject({
        manager: "pnpm",
        status: "ok",
      });
    });
  });
});

describe("checkUpdateStatus", () => {
  it("returns unknown install status when root is missing", async () => {
    await expect(
      checkUpdateStatus({ includeRegistry: false, root: null, timeoutMs: 1000 }),
    ).resolves.toEqual({
      installKind: "unknown",
      packageManager: "unknown",
      registry: undefined,
      root: null,
    });
  });

  it("detects package installs for non-git roots", async () => {
    await withTempDir({ prefix: "openclaw-update-check-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ packageManager: "npm@10.0.0" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      await expect(
        checkUpdateStatus({ fetchGit: false, includeRegistry: false, root, timeoutMs: 1000 }),
      ).resolves.toMatchObject({
        deps: {
          manager: "npm",
        },
        git: undefined,
        installKind: "package",
        packageManager: "npm",
        registry: undefined,
        root,
      });
    });
  });
});
