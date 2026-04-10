import { describe, expect, it, vi } from "vitest";

const validateRegistryNpmSpecMock = vi.hoisted(() => vi.fn());
const installFromNpmSpecArchiveWithInstallerMock = vi.hoisted(() => vi.fn());
const finalizeNpmSpecArchiveInstallMock = vi.hoisted(() => vi.fn());

vi.mock("./npm-registry-spec.js", () => ({
  validateRegistryNpmSpec: (...args: unknown[]) => validateRegistryNpmSpecMock(...args),
}));

vi.mock("./npm-pack-install.js", () => ({
  finalizeNpmSpecArchiveInstall: (...args: unknown[]) => finalizeNpmSpecArchiveInstallMock(...args),
  installFromNpmSpecArchiveWithInstaller: (...args: unknown[]) =>
    installFromNpmSpecArchiveWithInstallerMock(...args),
}));

import { installFromValidatedNpmSpecArchive } from "./install-from-npm-spec.js";

describe("installFromValidatedNpmSpecArchive", () => {
  it("trims the spec and returns validation errors before running the installer", async () => {
    validateRegistryNpmSpecMock.mockReturnValueOnce("unsupported npm spec");

    await expect(
      installFromValidatedNpmSpecArchive({
        archiveInstallParams: {},
        installFromArchive: vi.fn(),
        spec: "  nope  ",
        tempDirPrefix: "openclaw-npm-",
        timeoutMs: 30_000,
      }),
    ).resolves.toEqual({ error: "unsupported npm spec", ok: false });

    expect(validateRegistryNpmSpecMock).toHaveBeenCalledWith("nope");
    expect(installFromNpmSpecArchiveWithInstallerMock).not.toHaveBeenCalled();
    expect(finalizeNpmSpecArchiveInstallMock).not.toHaveBeenCalled();
  });

  it("passes the trimmed spec through the archive installer and finalizer", async () => {
    const installFromArchive = vi.fn();
    const warn = vi.fn();
    const onIntegrityDrift = vi.fn();
    const flowResult = {
      installResult: { ok: true },
      npmResolution: { version: "1.2.3" },
      ok: true,
    };
    const finalized = { archivePath: "/tmp/pkg.tgz", ok: true };
    validateRegistryNpmSpecMock.mockReturnValueOnce(null);
    installFromNpmSpecArchiveWithInstallerMock.mockResolvedValueOnce(flowResult);
    finalizeNpmSpecArchiveInstallMock.mockReturnValueOnce(finalized);

    await expect(
      installFromValidatedNpmSpecArchive({
        archiveInstallParams: { destination: "/tmp/demo" },
        expectedIntegrity: "sha512-demo",
        installFromArchive,
        onIntegrityDrift,
        spec: "  @openclaw/demo@beta  ",
        tempDirPrefix: "openclaw-npm-",
        timeoutMs: 45_000,
        warn,
      }),
    ).resolves.toBe(finalized);

    expect(installFromNpmSpecArchiveWithInstallerMock).toHaveBeenCalledWith({
      archiveInstallParams: { destination: "/tmp/demo" },
      expectedIntegrity: "sha512-demo",
      installFromArchive,
      onIntegrityDrift,
      spec: "@openclaw/demo@beta",
      tempDirPrefix: "openclaw-npm-",
      timeoutMs: 45_000,
      warn,
    });
    expect(finalizeNpmSpecArchiveInstallMock).toHaveBeenCalledWith(flowResult);
  });
});
