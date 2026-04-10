import { beforeEach, describe, expect, it, vi } from "vitest";
import { packNpmSpecToArchive, withTempDir } from "./install-source-utils.js";
import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";
import {
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchive,
  installFromNpmSpecArchiveWithInstaller,
} from "./npm-pack-install.js";

vi.mock("./install-source-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./install-source-utils.js")>(
    "./install-source-utils.js",
  );
  return {
    ...actual,
    packNpmSpecToArchive: vi.fn(),
    withTempDir: vi.fn(
      async (_prefix: string, fn: (tmpDir: string) => Promise<unknown>) =>
        await fn("/tmp/openclaw-npm-pack-install-test"),
    ),
  };
});

describe("installFromNpmSpecArchive", () => {
  const baseSpec = "@openclaw/test@1.0.0";
  const baseArchivePath = "/tmp/openclaw-test.tgz";

  const mockPackedSuccess = (overrides?: {
    resolvedSpec?: string;
    integrity?: string;
    name?: string;
    version?: string;
  }) => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      archivePath: baseArchivePath,
      metadata: {
        integrity: overrides?.integrity ?? "sha512-same",
        resolvedSpec: overrides?.resolvedSpec ?? baseSpec,
        ...(overrides?.name ? { name: overrides.name } : {}),
        ...(overrides?.version ? { version: overrides.version } : {}),
      },
      ok: true,
    });
  };

  const runInstall = async (overrides: {
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: {
      archivePath: string;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
  }) =>
    await installFromNpmSpecArchive({
      expectedIntegrity: overrides.expectedIntegrity,
      installFromArchive: overrides.installFromArchive,
      onIntegrityDrift: overrides.onIntegrityDrift,
      spec: baseSpec,
      tempDirPrefix: "openclaw-test-",
      timeoutMs: 1000,
      warn: overrides.warn,
    });

  const expectWrappedOkResult = (
    result: Awaited<ReturnType<typeof runInstall>>,
    installResult: Record<string, unknown>,
  ) => {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok result");
    }
    expect(result.installResult).toEqual(installResult);
    return result;
  };

  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
    vi.mocked(withTempDir).mockClear();
  });

  it("returns pack errors without invoking installer", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({ error: "pack failed", ok: false });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      installFromArchive,
      spec: "@openclaw/test@1.0.0",
      tempDirPrefix: "openclaw-test-",
      timeoutMs: 1000,
    });

    expect(result).toEqual({ error: "pack failed", ok: false });
    expect(installFromArchive).not.toHaveBeenCalled();
    expect(withTempDir).toHaveBeenCalledWith("openclaw-test-", expect.any(Function));
  });

  it("rejects unsupported npm specs before packing", async () => {
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      installFromArchive,
      spec: "file:/tmp/openclaw.tgz",
      tempDirPrefix: "openclaw-test-",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      error: "unsupported npm spec",
      ok: false,
    });
    expect(packNpmSpecToArchive).not.toHaveBeenCalled();
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("returns resolution metadata and installer result on success", async () => {
    mockPackedSuccess({ name: "@openclaw/test", version: "1.0.0" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, target: "done" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, target: "done" });
    expect(okResult.integrityDrift).toBeUndefined();
    expect(okResult.npmResolution.resolvedSpec).toBe("@openclaw/test@1.0.0");
    expect(okResult.npmResolution.resolvedAt).toBeTruthy();
    expect(installFromArchive).toHaveBeenCalledWith({ archivePath: "/tmp/openclaw-test.tgz" });
  });

  it("proceeds when integrity drift callback accepts drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const onIntegrityDrift = vi.fn(async () => true);
    const installFromArchive = vi.fn(async () => ({ id: "plugin-accept", ok: true as const }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      installFromArchive,
      onIntegrityDrift,
    });

    const okResult = expectWrappedOkResult(result, { id: "plugin-accept", ok: true });
    expect(okResult.integrityDrift).toEqual({
      actualIntegrity: "sha512-new",
      expectedIntegrity: "sha512-old",
    });
    expect(onIntegrityDrift).toHaveBeenCalledTimes(1);
  });

  it("aborts when integrity drift callback rejects drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      installFromArchive,
      onIntegrityDrift: async () => false,
    });

    expect(result).toEqual({
      error: "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
      ok: false,
    });
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("warns and proceeds on drift when no callback is configured", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const warn = vi.fn();
    const installFromArchive = vi.fn(async () => ({ id: "plugin-1", ok: true as const }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      installFromArchive,
      warn,
    });

    const okResult = expectWrappedOkResult(result, { id: "plugin-1", ok: true });
    expect(okResult.integrityDrift).toEqual({
      actualIntegrity: "sha512-new",
      expectedIntegrity: "sha512-old",
    });
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );
  });

  it("returns installer failures to callers for domain-specific handling", async () => {
    mockPackedSuccess({ integrity: "sha512-same" });
    const installFromArchive = vi.fn(async () => ({ error: "install failed", ok: false as const }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { error: "install failed", ok: false });
    expect(okResult.integrityDrift).toBeUndefined();
  });

  it("rejects prerelease resolutions unless explicitly requested", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      archivePath: baseArchivePath,
      metadata: {
        integrity: "sha512-same",
        resolvedSpec: "@openclaw/test@latest",
        version: "1.1.0-beta.1",
      },
      ok: true,
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      installFromArchive,
      spec: "@openclaw/test@latest",
      tempDirPrefix: "openclaw-test-",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected prerelease rejection");
    }
    expect(result.error).toContain("prerelease version 1.1.0-beta.1");
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("allows prerelease resolutions when explicitly requested by tag", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      archivePath: baseArchivePath,
      metadata: {
        integrity: "sha512-same",
        resolvedSpec: "@openclaw/test@beta",
        version: "1.1.0-beta.1",
      },
      ok: true,
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, pluginId: "beta-plugin" }));

    const result = await installFromNpmSpecArchive({
      installFromArchive,
      spec: "@openclaw/test@beta",
      tempDirPrefix: "openclaw-test-",
      timeoutMs: 1000,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, pluginId: "beta-plugin" });
    expect(okResult.npmResolution.version).toBe("1.1.0-beta.1");
  });
});

describe("installFromNpmSpecArchiveWithInstaller", () => {
  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
  });

  it("passes archive path and installer params to installFromArchive", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      archivePath: "/tmp/openclaw-plugin.tgz",
      metadata: {
        integrity: "sha512-same",
        resolvedSpec: "@openclaw/voice-call@1.0.0",
      },
      ok: true,
    });
    const installFromArchive = vi.fn(
      async (_params: { archivePath: string; pluginId: string }) =>
        ({ ok: true as const, pluginId: "voice-call" }) as const,
    );

    const result = await installFromNpmSpecArchiveWithInstaller({
      archiveInstallParams: { pluginId: "voice-call" },
      installFromArchive,
      spec: "@openclaw/voice-call@1.0.0",
      tempDirPrefix: "openclaw-test-",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(installFromArchive).toHaveBeenCalledWith({
      archivePath: "/tmp/openclaw-plugin.tgz",
      pluginId: "voice-call",
    });
    expect(result.installResult).toEqual({ ok: true, pluginId: "voice-call" });
  });
});

describe("finalizeNpmSpecArchiveInstall", () => {
  it("returns top-level flow errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      error: "pack failed",
      ok: false,
    });

    expect(result).toEqual({ error: "pack failed", ok: false });
  });

  it("returns install errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      installResult: { error: "install failed", ok: false },
      npmResolution: {
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
        resolvedSpec: "@openclaw/test@1.0.0",
      },
      ok: true,
    });

    expect(result).toEqual({ error: "install failed", ok: false });
  });

  it("attaches npm metadata to successful install results", () => {
    const result = finalizeNpmSpecArchiveInstall<
      { ok: true; pluginId: string } | { ok: false; error: string }
    >({
      installResult: { ok: true, pluginId: "voice-call" },
      integrityDrift: {
        actualIntegrity: "sha512-same",
        expectedIntegrity: "sha512-old",
      },
      npmResolution: {
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
        resolvedSpec: "@openclaw/voice-call@1.0.0",
      },
      ok: true,
    });

    expect(result).toEqual({
      integrityDrift: {
        actualIntegrity: "sha512-same",
        expectedIntegrity: "sha512-old",
      },
      npmResolution: {
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
        resolvedSpec: "@openclaw/voice-call@1.0.0",
      },
      ok: true,
      pluginId: "voice-call",
    });
  });
});
