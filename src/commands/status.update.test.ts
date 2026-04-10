import { describe, expect, it } from "vitest";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { VERSION } from "../version.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
} from "./status.update.js";

function buildUpdate(partial: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
    installKind: "unknown",
    packageManager: "unknown",
    root: null,
    ...partial,
  };
}

function nextMajorVersion(version: string): string {
  const [majorPart] = version.split(".");
  const major = Number.parseInt(majorPart ?? "", 10);
  if (Number.isFinite(major) && major >= 0) {
    return `${major + 1}.0.0`;
  }
  return "999999.0.0";
}

describe("resolveUpdateAvailability", () => {
  it("flags git update when behind upstream", () => {
    const update = buildUpdate({
      git: {
        ahead: 0,
        behind: 3,
        branch: "main",
        dirty: false,
        fetchOk: true,
        root: "/tmp/repo",
        sha: null,
        tag: null,
        upstream: "origin/main",
      },
      installKind: "git",
    });
    expect(resolveUpdateAvailability(update)).toEqual({
      available: true,
      gitBehind: 3,
      hasGitUpdate: true,
      hasRegistryUpdate: false,
      latestVersion: null,
    });
  });

  it("flags registry update when latest version is newer", () => {
    const latestVersion = nextMajorVersion(VERSION);
    const update = buildUpdate({
      installKind: "package",
      packageManager: "pnpm",
      registry: { latestVersion },
    });
    const availability = resolveUpdateAvailability(update);
    expect(availability.available).toBe(true);
    expect(availability.hasGitUpdate).toBe(false);
    expect(availability.hasRegistryUpdate).toBe(true);
    expect(availability.latestVersion).toBe(latestVersion);
  });
});

describe("formatUpdateOneLiner", () => {
  it("renders git status and registry summary without duplicating up to date", () => {
    const update = buildUpdate({
      deps: {
        lockfilePath: "pnpm-lock.yaml",
        manager: "pnpm",
        markerPath: "node_modules/.modules.yaml",
        status: "ok",
      },
      git: {
        ahead: 0,
        behind: 2,
        branch: "main",
        dirty: true,
        fetchOk: true,
        root: "/tmp/repo",
        sha: "abc123456789",
        tag: null,
        upstream: "origin/main",
      },
      installKind: "git",
      registry: { latestVersion: VERSION },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: git main · ↔ origin/main · dirty · behind 2 · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders synced git installs with a single up to date label", () => {
    const update = buildUpdate({
      deps: {
        lockfilePath: "pnpm-lock.yaml",
        manager: "pnpm",
        markerPath: "node_modules/.modules.yaml",
        status: "ok",
      },
      git: {
        ahead: 0,
        behind: 0,
        branch: "main",
        dirty: false,
        fetchOk: true,
        root: "/tmp/repo",
        sha: "abc123456789",
        tag: null,
        upstream: "origin/main",
      },
      installKind: "git",
      registry: { latestVersion: VERSION },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: git main · ↔ origin/main · up to date · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders package-manager mode with explicit up-to-date state", () => {
    const update = buildUpdate({
      deps: {
        lockfilePath: "package-lock.json",
        manager: "npm",
        markerPath: "node_modules",
        status: "ok",
      },
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: VERSION },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: npm · up to date · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders package-manager mode with registry error", () => {
    const update = buildUpdate({
      deps: {
        lockfilePath: "package-lock.json",
        manager: "npm",
        markerPath: "node_modules",
        status: "missing",
      },
      installKind: "package",
      packageManager: "npm",
      registry: { error: "offline", latestVersion: null },
    });

    expect(formatUpdateOneLiner(update)).toBe("Update: npm · npm latest unknown · deps missing");
  });
});

describe("formatUpdateAvailableHint", () => {
  it("returns null when no update is available", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "pnpm",
      registry: { latestVersion: VERSION },
    });

    expect(formatUpdateAvailableHint(update)).toBeNull();
  });

  it("renders git and registry update details", () => {
    const latestVersion = nextMajorVersion(VERSION);
    const update = buildUpdate({
      git: {
        ahead: 0,
        behind: 2,
        branch: "main",
        dirty: false,
        fetchOk: true,
        root: "/tmp/repo",
        sha: null,
        tag: null,
        upstream: "origin/main",
      },
      installKind: "git",
      registry: { latestVersion },
    });

    expect(formatUpdateAvailableHint(update)).toBe(
      `Update available (git behind 2 · npm ${latestVersion}). Run: openclaw update`,
    );
  });
});
