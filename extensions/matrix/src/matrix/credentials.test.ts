import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  resolveMatrixCredentialsPath,
  saveBackfilledMatrixDeviceId,
  saveMatrixCredentials,
  touchMatrixCredentials,
} from "./credentials.js";

describe("matrix credentials storage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function setupStateDir(
    cfg: Record<string, unknown> = {
      channels: {
        matrix: {},
      },
    },
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-creds-"));
    tempDirs.push(dir);
    installMatrixTestRuntime({ cfg, stateDir: dir });
    return dir;
  }

  it("writes credentials atomically with secure file permissions", async () => {
    const stateDir = setupStateDir();
    await saveMatrixCredentials(
      {
        accessToken: "secret-token",
        deviceId: "DEVICE123",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      },
      {},
      "ops",
    );

    const credPath = resolveMatrixCredentialsPath({}, "ops");
    expect(fs.existsSync(credPath)).toBe(true);
    expect(credPath).toBe(path.join(stateDir, "credentials", "matrix", "credentials-ops.json"));
    const mode = fs.statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("touch updates lastUsedAt while preserving createdAt", async () => {
    setupStateDir();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      await saveMatrixCredentials(
        {
          accessToken: "secret-token",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
        {},
        "default",
      );
      const initial = loadMatrixCredentials({}, "default");
      expect(initial).not.toBeNull();

      vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
      await touchMatrixCredentials({}, "default");
      const touched = loadMatrixCredentials({}, "default");
      expect(touched).not.toBeNull();

      expect(touched?.createdAt).toBe(initial?.createdAt);
      expect(touched?.lastUsedAt).toBe("2026-03-01T10:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfill updates deviceId when credentials still match the same auth lineage", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        accessToken: "tok-123",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          accessToken: "tok-123",
          deviceId: "DEVICE123",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
        {},
        "default",
      ),
    ).resolves.toBe("saved");

    expect(loadMatrixCredentials({}, "default")).toMatchObject({
      accessToken: "tok-123",
      deviceId: "DEVICE123",
    });
  });

  it("backfill skips when newer credentials already changed the token", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        accessToken: "tok-new",
        deviceId: "DEVICE999",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          accessToken: "tok-old",
          deviceId: "DEVICE123",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
        {},
        "default",
      ),
    ).resolves.toBe("skipped");

    expect(loadMatrixCredentials({}, "default")).toMatchObject({
      accessToken: "tok-new",
      deviceId: "DEVICE999",
    });
  });

  it("serializes stale backfill writes behind newer credential saves", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        accessToken: "tok-old",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      },
      {},
      "default",
    );

    let releaseFirstWrite: (() => void) | undefined;
    let firstWriteStarted = false;
    const originalRename = fsPromises.rename.bind(fsPromises);
    const renameSpy = vi
      .spyOn(fsPromises, "rename")
      .mockImplementation(async (...args: Parameters<typeof fsPromises.rename>) => {
        if (!firstWriteStarted) {
          firstWriteStarted = true;
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        await originalRename(...args);
      });

    try {
      const staleBackfillPromise = saveBackfilledMatrixDeviceId(
        {
          accessToken: "tok-old",
          deviceId: "DEVICE123",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
        {},
        "default",
      );

      await vi.waitFor(() => {
        expect(firstWriteStarted).toBe(true);
      });

      const newerSavePromise = saveMatrixCredentials(
        {
          accessToken: "tok-new",
          deviceId: "DEVICE999",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
        {},
        "default",
      );

      releaseFirstWrite?.();
      await Promise.all([staleBackfillPromise, newerSavePromise]);

      expect(loadMatrixCredentials({}, "default")).toMatchObject({
        accessToken: "tok-new",
        deviceId: "DEVICE999",
      });
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("migrates legacy matrix credential files on read", async () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      }),
    );

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded?.accessToken).toBe("legacy-token");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(currentPath)).toBe(true);
  });

  it("returns migrated credentials when another process moves the legacy file mid-read", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      }),
    );

    const originalReadFileSync = fs.readFileSync.bind(fs);
    let moved = false;
    const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      options?: fs.ObjectEncodingOptions | BufferEncoding | null,
    ) => {
      if (!moved && filePath === legacyPath) {
        fs.renameSync(legacyPath, currentPath);
        moved = true;
      }
      return originalReadFileSync(filePath, options as never);
    }) as typeof fs.readFileSync);
    try {
      const loaded = loadMatrixCredentials({}, "ops");

      expect(loaded?.accessToken).toBe("legacy-token");
      expect(moved).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(currentPath)).toBe(true);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("does not rename the legacy path after falling back to already-migrated current credentials", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      }),
    );

    const originalReadFileSync = fs.readFileSync.bind(fs);
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync");
    let migrated = false;
    const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      options?: fs.ObjectEncodingOptions | BufferEncoding | null,
    ) => {
      if (!migrated && filePath === legacyPath && fs.existsSync(legacyPath)) {
        originalRenameSync(legacyPath, currentPath);
        fs.writeFileSync(
          currentPath,
          JSON.stringify({
            accessToken: "current-token",
            createdAt: "2026-03-01T10:00:00.000Z",
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
          }),
        );
        migrated = true;
        try {
          return originalReadFileSync(filePath, options as never);
        } finally {
          fs.writeFileSync(
            legacyPath,
            JSON.stringify({
              accessToken: "recreated-stale-legacy-token",
              createdAt: "2026-03-01T10:00:00.000Z",
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
            }),
          );
        }
      }
      return originalReadFileSync(filePath, options as never);
    }) as typeof fs.readFileSync);

    try {
      const loaded = loadMatrixCredentials({}, "ops");

      expect(loaded?.accessToken).toBe("current-token");
      expect(renameSpy).not.toHaveBeenCalled();
      expect(
        JSON.parse(fs.readFileSync(currentPath, "utf8")) as { accessToken: string },
      ).toMatchObject({
        accessToken: "current-token",
      });
      expect(
        JSON.parse(fs.readFileSync(legacyPath, "utf8")) as { accessToken: string },
      ).toMatchObject({
        accessToken: "recreated-stale-legacy-token",
      });
    } finally {
      readFileSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it("does not migrate legacy default credentials during a non-selected account read", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            default: {
              accessToken: "default-token",
              homeserver: "https://matrix.default.example.org",
            },
            ops: {},
          },
          defaultAccount: "default",
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accessToken: "default-token",
        createdAt: "2026-03-01T10:00:00.000Z",
        homeserver: "https://matrix.default.example.org",
        userId: "@default:example.org",
      }),
    );

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded).toBeNull();
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(currentPath)).toBe(false);
  });

  it("migrates legacy credentials to the named account when top-level auth is only a shared default", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accessToken: "shared-token",
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
          },
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
      }),
    );

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded?.accessToken).toBe("legacy-token");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(currentPath)).toBe(true);
  });

  it("clears both current and legacy credential paths", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    });
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(currentPath, "{}");
    fs.writeFileSync(legacyPath, "{}");

    clearMatrixCredentials({}, "ops");

    expect(fs.existsSync(currentPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("requires a token match when userId is absent", () => {
    expect(
      credentialsMatchConfig(
        {
          accessToken: "tok-old",
          createdAt: "2026-01-01T00:00:00.000Z",
          homeserver: "https://matrix.example.org",
          userId: "@old:example.org",
        },
        {
          accessToken: "tok-new",
          homeserver: "https://matrix.example.org",
          userId: "",
        },
      ),
    ).toBe(false);

    expect(
      credentialsMatchConfig(
        {
          accessToken: "tok-123",
          createdAt: "2026-01-01T00:00:00.000Z",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
        {
          accessToken: "tok-123",
          homeserver: "https://matrix.example.org",
          userId: "",
        },
      ),
    ).toBe(true);
  });
});
