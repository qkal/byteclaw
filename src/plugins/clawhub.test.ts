import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parseClawHubPluginSpecMock = vi.fn();
const fetchClawHubPackageDetailMock = vi.fn();
const fetchClawHubPackageVersionMock = vi.fn();
const downloadClawHubPackageArchiveMock = vi.fn();
const archiveCleanupMock = vi.fn();
const resolveLatestVersionFromPackageMock = vi.fn();
const resolveCompatibilityHostVersionMock = vi.fn();
const installPluginFromArchiveMock = vi.fn();

vi.mock("../infra/clawhub.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub.js")>("../infra/clawhub.js");
  return {
    ...actual,
    downloadClawHubPackageArchive: (...args: unknown[]) =>
      downloadClawHubPackageArchiveMock(...args),
    fetchClawHubPackageDetail: (...args: unknown[]) => fetchClawHubPackageDetailMock(...args),
    fetchClawHubPackageVersion: (...args: unknown[]) => fetchClawHubPackageVersionMock(...args),
    parseClawHubPluginSpec: (...args: unknown[]) => parseClawHubPluginSpecMock(...args),
    resolveLatestVersionFromPackage: (...args: unknown[]) =>
      resolveLatestVersionFromPackageMock(...args),
  };
});

vi.mock("../version.js", () => ({
  resolveCompatibilityHostVersion: (...args: unknown[]) =>
    resolveCompatibilityHostVersionMock(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromArchive: (...args: unknown[]) => installPluginFromArchiveMock(...args),
}));

vi.mock("../infra/archive.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/archive.js")>("../infra/archive.js");
  return {
    ...actual,
    DEFAULT_MAX_ENTRIES: 50_000,
    DEFAULT_MAX_ENTRY_BYTES: 256 * 1024 * 1024,
    DEFAULT_MAX_EXTRACTED_BYTES: 512 * 1024 * 1024,
  };
});

const { ClawHubRequestError } = await import("../infra/clawhub.js");
const { CLAWHUB_INSTALL_ERROR_CODE, formatClawHubSpecifier, installPluginFromClawHub } =
  await import("./clawhub.js");

const DEMO_ARCHIVE_INTEGRITY = "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8=";
const tempDirs: string[] = [];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createClawHubArchive(entries: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
  tempDirs.push(dir);
  const archivePath = path.join(dir, "archive.zip");
  const zip = new JSZip();
  for (const [filePath, contents] of Object.entries(entries)) {
    zip.file(filePath, contents);
  }
  const archiveBytes = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(archivePath, archiveBytes);
  return {
    archivePath,
    integrity: `sha256-${createHash("sha256").update(archiveBytes).digest("base64")}`,
  };
}

async function expectClawHubInstallError(params: {
  setup?: () => void;
  spec: string;
  expected: {
    ok: false;
    code: (typeof CLAWHUB_INSTALL_ERROR_CODE)[keyof typeof CLAWHUB_INSTALL_ERROR_CODE];
    error: string;
  };
}) {
  params.setup?.();
  await expect(installPluginFromClawHub({ spec: params.spec })).resolves.toMatchObject(
    params.expected,
  );
}

function createLoggerSpies() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function expectClawHubInstallFlow(params: {
  baseUrl: string;
  version: string;
  archivePath: string;
}) {
  expect(fetchClawHubPackageDetailMock).toHaveBeenCalledWith(
    expect.objectContaining({
      baseUrl: params.baseUrl,
      name: "demo",
    }),
  );
  expect(fetchClawHubPackageVersionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "demo",
      version: params.version,
    }),
  );
  expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
    expect.objectContaining({
      archivePath: params.archivePath,
    }),
  );
}

function expectSuccessfulClawHubInstall(result: unknown) {
  expect(result).toMatchObject({
    clawhub: {
      clawhubChannel: "official",
      clawhubFamily: "code-plugin",
      clawhubPackage: "demo",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      source: "clawhub",
    },
    ok: true,
    pluginId: "demo",
    version: "2026.3.22",
  });
}

describe("installPluginFromClawHub", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  beforeEach(() => {
    parseClawHubPluginSpecMock.mockReset();
    fetchClawHubPackageDetailMock.mockReset();
    fetchClawHubPackageVersionMock.mockReset();
    downloadClawHubPackageArchiveMock.mockReset();
    archiveCleanupMock.mockReset();
    resolveLatestVersionFromPackageMock.mockReset();
    resolveCompatibilityHostVersionMock.mockReset();
    installPluginFromArchiveMock.mockReset();

    parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    fetchClawHubPackageDetailMock.mockResolvedValue({
      package: {
        channel: "official",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        displayName: "Demo",
        family: "code-plugin",
        isOfficial: true,
        name: "demo",
        updatedAt: 0,
      },
    });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.3.22");
    fetchClawHubPackageVersionMock.mockResolvedValue({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValue({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      cleanup: archiveCleanupMock,
      integrity: DEMO_ARCHIVE_INTEGRITY,
    });
    archiveCleanupMock.mockResolvedValue(undefined);
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.3.22");
    installPluginFromArchiveMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/openclaw/plugins/demo",
      version: "2026.3.22",
    });
  });

  it("formats clawhub specifiers", () => {
    expect(formatClawHubSpecifier({ name: "demo" })).toBe("clawhub:demo");
    expect(formatClawHubSpecifier({ name: "demo", version: "1.2.3" })).toBe("clawhub:demo@1.2.3");
  });

  it("installs a ClawHub code plugin through the archive installer", async () => {
    const logger = createLoggerSpies();
    const result = await installPluginFromClawHub({
      baseUrl: "https://clawhub.ai",
      logger,
      spec: "clawhub:demo",
    });

    expectClawHubInstallFlow({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      baseUrl: "https://clawhub.ai",
      version: "2026.3.22",
    });
    expectSuccessfulClawHubInstall(result);
    expect(logger.info).toHaveBeenCalledWith("ClawHub code-plugin demo@2026.3.22 channel=official");
    expect(logger.info).toHaveBeenCalledWith(
      "Compatibility: pluginApi=>=2026.3.22 minGateway=2026.3.0",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("passes dangerous force unsafe install through to archive installs", async () => {
    await installPluginFromClawHub({
      dangerouslyForceUnsafeInstall: true,
      spec: "clawhub:demo",
    });

    expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath: "/tmp/clawhub-demo/archive.zip",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("cleans up the downloaded archive even when archive install fails", async () => {
    installPluginFromArchiveMock.mockResolvedValueOnce({
      error: "bad archive",
      ok: false,
    });

    const result = await installPluginFromClawHub({
      baseUrl: "https://clawhub.ai",
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      error: "bad archive",
      ok: false,
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("accepts version-endpoint SHA-256 hashes expressed as raw hex", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      cleanup: archiveCleanupMock,
      integrity: "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8=",
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
  });

  it("accepts version-endpoint SHA-256 hashes expressed as unpadded SRI", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        sha256hash: "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8",
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      cleanup: archiveCleanupMock,
      integrity: DEMO_ARCHIVE_INTEGRITY,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
  });

  it("falls back to strict files[] verification when sha256hash is missing", async () => {
    const archive = await createClawHubArchive({
      "_meta.json": '{"slug":"demo","version":"2026.3.22"}',
      "dist/index.js": 'export const demo = "ok";',
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "dist/index.js",
            sha256: sha256Hex('export const demo = "ok";'),
            size: 25,
          },
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        sha256hash: null,
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      logger,
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: dist/index.js, openclaw.plugin.json. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  it("validates _meta.json against canonical package and resolved version metadata", async () => {
    const archive = await createClawHubArchive({
      "_meta.json": '{"slug":"demo","version":"2026.3.22"}',
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "DemoAlias", version: "latest" });
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        channel: "official",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        displayName: "Demo",
        family: "code-plugin",
        isOfficial: true,
        name: "demo",
        updatedAt: 0,
      },
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        sha256hash: null,
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      logger,
      spec: "clawhub:DemoAlias@latest",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo", version: "2026.3.22" });
    expect(fetchClawHubPackageDetailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DemoAlias",
      }),
    );
    expect(fetchClawHubPackageVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "latest",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: openclaw.plugin.json. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  it("fails closed when sha256hash is present but unrecognized instead of silently falling back", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        sha256hash: "definitely-not-a-sha256",
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid sha256hash (unrecognized value "definitely-not-a-sha256").',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when sha256hash is explicitly null and files[] is unavailable", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        sha256hash: null,
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" is missing sha256hash and usable files[] metadata for fallback archive verification.',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when the version metadata has no archive hash or fallback files[]", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" is missing sha256hash and usable files[] metadata for fallback archive verification.',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("fails closed when files[] contains a malformed entry", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [null as unknown as { path: string; sha256: string }],
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0] entry (expected an object, got null).',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("fails closed when files[] contains an invalid sha256", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: "not-a-digest",
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].sha256 (value "not-a-digest" is not a 64-character hexadecimal SHA-256 digest).',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("fails closed when sha256hash is not a string", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        sha256hash: 123 as unknown as string,
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid sha256hash (non-string value of type number).',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("returns a typed install failure when the archive download throws", async () => {
    downloadClawHubPackageArchiveMock.mockRejectedValueOnce(new Error("network timeout"));

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      error: "network timeout",
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("returns a typed install failure when fallback archive verification cannot read the zip", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "not-a-zip", "utf8");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      cleanup: archiveCleanupMock,
      integrity: "sha256-not-used-in-fallback",
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: "ClawHub archive fallback verification failed while reading the downloaded archive.",
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when the downloaded archive hash drifts from metadata", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        sha256hash: "1111111111111111111111111111111111111111111111111111111111111111",
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      cleanup: archiveCleanupMock,
      integrity: DEMO_ARCHIVE_INTEGRITY,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: `ClawHub archive integrity mismatch for "demo@2026.3.22": expected sha256-ERERERERERERERERERERERERERERERERERERERERERE=, got ${DEMO_ARCHIVE_INTEGRITY}.`,
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("rejects fallback verification when an expected file is missing from the archive", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
          {
            path: "dist/index.js",
            sha256: sha256Hex('export const demo = "ok";'),
            size: 25,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": missing "dist/index.js".',
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when the archive includes an unexpected file", async () => {
    const archive = await createClawHubArchive({
      "dist/index.js": 'export const demo = "ok";',
      "extra.txt": "surprise",
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
          {
            path: "dist/index.js",
            sha256: sha256Hex('export const demo = "ok";'),
            size: 25,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": unexpected file "extra.txt".',
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("accepts root-level files[] paths and allows _meta.json as an unvalidated generated file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    const zip = new JSZip();
    zip.file("scripts/search.py", "print('ok')\n");
    zip.file("SKILL.md", "# Demo\n");
    zip.file("_meta.json", '{"slug":"demo","version":"2026.3.22"}');
    const archiveBytes = await zip.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(archivePath, archiveBytes);
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "scripts/search.py",
            sha256: sha256Hex("print('ok')\n"),
            size: 12,
          },
          {
            path: "SKILL.md",
            sha256: sha256Hex("# Demo\n"),
            size: 7,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      cleanup: archiveCleanupMock,
      integrity: `sha256-${createHash("sha256").update(archiveBytes).digest("base64")}`,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      logger,
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: SKILL.md, scripts/search.py. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  it("omits the skipped-files suffix when no generated extras are present", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      logger,
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: openclaw.plugin.json.',
    );
  });

  it("rejects fallback verification when _meta.json is not valid JSON", async () => {
    const archive = await createClawHubArchive({
      "_meta.json": "{not-json",
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": _meta.json is not valid JSON.',
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when _meta.json slug does not match the package name", async () => {
    const archive = await createClawHubArchive({
      "_meta.json": '{"slug":"wrong","version":"2026.3.22"}',
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": _meta.json slug does not match the package name.',
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when _meta.json exceeds the per-file size limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "placeholder", "utf8");
    const oversizedMetaEntry = {
      _data: { uncompressedSize: 256 * 1024 * 1024 + 1 },
      dir: false,
      name: "_meta.json",
      nodeStream: vi.fn(),
    } as unknown as JSZip.JSZipObject;
    const listedFileEntry = {
      _data: { uncompressedSize: 13 },
      dir: false,
      name: "openclaw.plugin.json",
      nodeStream: () => Readable.from([Buffer.from('{"id":"demo"}')]),
    } as unknown as JSZip.JSZipObject;
    const loadAsyncSpy = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce({
      files: {
        "_meta.json": oversizedMetaEntry,
        "openclaw.plugin.json": listedFileEntry,
      },
    } as unknown as JSZip);
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      cleanup: archiveCleanupMock,
      integrity: "sha256-not-used-in-fallback",
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    loadAsyncSpy.mockRestore();
    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive fallback verification rejected "_meta.json" because it exceeds the per-file size limit.',
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when archive directories alone exceed the entry limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "placeholder", "utf8");
    const zipEntries = Object.fromEntries(
      Array.from({ length: 50_001 }, (_, index) => [
        `folder-${index}/`,
        {
          dir: true,
          name: `folder-${index}/`,
        },
      ]),
    );
    const loadAsyncSpy = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce({
      files: zipEntries,
    } as unknown as JSZip);
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      cleanup: archiveCleanupMock,
      integrity: "sha256-not-used-in-fallback",
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    loadAsyncSpy.mockRestore();
    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: "ClawHub archive fallback verification exceeded the archive entry limit.",
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when the downloaded archive exceeds the ZIP size limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "placeholder", "utf8");
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (filePath, options) => {
      if (filePath === archivePath) {
        return {
          size: 256 * 1024 * 1024 + 1,
        } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return await realStat(filePath, options);
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      cleanup: archiveCleanupMock,
      integrity: "sha256-not-used-in-fallback",
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    statSpy.mockRestore();
    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when a file hash drifts from files[] metadata", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: "1".repeat(64),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": expected openclaw.plugin.json to hash to ${"1".repeat(64)}, got ${sha256Hex('{"id":"demo"}')}.`,
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata with an unsafe files[] path", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "../evil.txt",
            sha256: "1".repeat(64),
            size: 4,
          },
        ],
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].path (path "../evil.txt" contains dot segments).',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata with leading or trailing path whitespace", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json ",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].path (path "openclaw.plugin.json " has leading or trailing whitespace).',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when the archive includes a whitespace-suffixed file path", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
      "openclaw.plugin.json ": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": invalid package file path "openclaw.plugin.json " (path "openclaw.plugin.json " has leading or trailing whitespace).',
      ok: false,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata with duplicate files[] paths", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
          {
            path: "openclaw.plugin.json",
            sha256: sha256Hex('{"id":"demo"}'),
            size: 13,
          },
        ],
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has duplicate files[] path "openclaw.plugin.json".',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata when files[] includes generated _meta.json", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        changelog: "",
        compatibility: {
          minGatewayVersion: "2026.3.0",
          pluginApiRange: ">=2026.3.22",
        },
        createdAt: 0,
        files: [
          {
            path: "_meta.json",
            sha256: sha256Hex('{"slug":"demo","version":"2026.3.22"}'),
            size: 64,
          },
        ],
        version: "2026.3.22",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" must not include generated file "_meta.json" in files[].',
      ok: false,
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: {
        code: CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
        error:
          'Plugin "demo" requires plugin API >=2026.3.22, but this OpenClaw runtime exposes 2026.3.21.',
        ok: false,
      },
      name: "rejects packages whose plugin API range exceeds the runtime version",
      setup: () => {
        resolveCompatibilityHostVersionMock.mockReturnValueOnce("2026.3.21");
      },
      spec: "clawhub:demo",
    },
    {
      expected: {
        code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
        error: '"calendar" is a skill. Use "openclaw skills install calendar" instead.',
        ok: false,
      },
      name: "rejects skill families and redirects to skills install",
      setup: () => {
        fetchClawHubPackageDetailMock.mockResolvedValueOnce({
          package: {
            channel: "official",
            createdAt: 0,
            displayName: "Calendar",
            family: "skill",
            isOfficial: true,
            name: "calendar",
            updatedAt: 0,
          },
        });
      },
      spec: "clawhub:calendar",
    },
    {
      expected: {
        code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
        error: '"calendar" is a skill. Use "openclaw skills install calendar" instead.',
        ok: false,
      },
      name: "redirects skill families before missing archive metadata checks",
      setup: () => {
        fetchClawHubPackageDetailMock.mockResolvedValueOnce({
          package: {
            channel: "official",
            createdAt: 0,
            displayName: "Calendar",
            family: "skill",
            isOfficial: true,
            name: "calendar",
            updatedAt: 0,
          },
        });
        fetchClawHubPackageVersionMock.mockResolvedValueOnce({
          version: {
            changelog: "",
            createdAt: 0,
            version: "2026.3.22",
          },
        });
      },
      spec: "clawhub:calendar",
    },
    {
      expected: {
        code: CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
        error: "Package not found on ClawHub.",
        ok: false,
      },
      name: "returns typed package-not-found failures",
      setup: () => {
        fetchClawHubPackageDetailMock.mockRejectedValueOnce(
          new ClawHubRequestError({
            body: "Package not found",
            path: "/api/v1/packages/demo",
            status: 404,
          }),
        );
      },
      spec: "clawhub:demo",
    },
    {
      expected: {
        code: CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND,
        error: "Version not found on ClawHub: demo@9.9.9.",
        ok: false,
      },
      name: "returns typed version-not-found failures",
      setup: () => {
        parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "9.9.9" });
        fetchClawHubPackageVersionMock.mockRejectedValueOnce(
          new ClawHubRequestError({
            body: "Version not found",
            path: "/api/v1/packages/demo/versions/9.9.9",
            status: 404,
          }),
        );
      },
      spec: "clawhub:demo@9.9.9",
    },
  ] as const)("$name", async ({ setup, spec, expected }) => {
    await expectClawHubInstallError({ expected, setup, spec });
  });
});
