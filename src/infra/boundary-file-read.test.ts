import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveBoundaryPathSyncMock = vi.hoisted(() => vi.fn());
const resolveBoundaryPathMock = vi.hoisted(() => vi.fn());
const openVerifiedFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("./boundary-path.js", () => ({
  resolveBoundaryPath: (...args: unknown[]) => resolveBoundaryPathMock(...args),
  resolveBoundaryPathSync: (...args: unknown[]) => resolveBoundaryPathSyncMock(...args),
}));

vi.mock("./safe-open-sync.js", () => ({
  openVerifiedFileSync: (...args: unknown[]) => openVerifiedFileSyncMock(...args),
}));

let canUseBoundaryFileOpen: typeof import("./boundary-file-read.js").canUseBoundaryFileOpen;
let matchBoundaryFileOpenFailure: typeof import("./boundary-file-read.js").matchBoundaryFileOpenFailure;
let openBoundaryFile: typeof import("./boundary-file-read.js").openBoundaryFile;
let openBoundaryFileSync: typeof import("./boundary-file-read.js").openBoundaryFileSync;

describe("boundary-file-read", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      canUseBoundaryFileOpen,
      matchBoundaryFileOpenFailure,
      openBoundaryFile,
      openBoundaryFileSync,
    } = await import("./boundary-file-read.js"));
    resolveBoundaryPathSyncMock.mockReset();
    resolveBoundaryPathMock.mockReset();
    openVerifiedFileSyncMock.mockReset();
  });

  it("recognizes the required sync fs surface", () => {
    const validFs = {
      closeSync() {},
      constants: {},
      fstatSync() {},
      lstatSync() {},
      openSync() {},
      readFileSync() {},
      realpathSync() {},
    };

    expect(canUseBoundaryFileOpen(validFs as never)).toBe(true);
    expect(
      canUseBoundaryFileOpen({
        ...validFs,
        openSync: undefined,
      } as never),
    ).toBe(false);
    expect(
      canUseBoundaryFileOpen({
        ...validFs,
        constants: null,
      } as never),
    ).toBe(false);
  });

  it("maps sync boundary resolution into verified file opens", () => {
    const stat = { size: 3 } as never;
    const ioFs = { marker: "io" } as never;
    const absolutePath = path.resolve("plugin.json");

    resolveBoundaryPathSyncMock.mockReturnValue({
      canonicalPath: "/real/plugin.json",
      rootCanonicalPath: "/real/root",
    });
    openVerifiedFileSyncMock.mockReturnValue({
      fd: 7,
      ok: true,
      path: "/real/plugin.json",
      stat,
    });

    const opened = openBoundaryFileSync({
      absolutePath: "plugin.json",
      boundaryLabel: "plugin root",
      ioFs,
      rootPath: "/workspace",
    });

    expect(resolveBoundaryPathSyncMock).toHaveBeenCalledWith({
      absolutePath,
      boundaryLabel: "plugin root",
      rootCanonicalPath: undefined,
      rootPath: "/workspace",
      skipLexicalRootCheck: undefined,
    });
    expect(openVerifiedFileSyncMock).toHaveBeenCalledWith({
      allowedType: undefined,
      filePath: absolutePath,
      ioFs,
      maxBytes: undefined,
      rejectHardlinks: true,
      resolvedPath: "/real/plugin.json",
    });
    expect(opened).toEqual({
      fd: 7,
      ok: true,
      path: "/real/plugin.json",
      rootRealPath: "/real/root",
      stat,
    });
  });

  it("returns validation errors when sync boundary resolution throws", () => {
    const error = new Error("outside root");
    resolveBoundaryPathSyncMock.mockImplementation(() => {
      throw error;
    });

    const opened = openBoundaryFileSync({
      absolutePath: "plugin.json",
      boundaryLabel: "plugin root",
      rootPath: "/workspace",
    });

    expect(opened).toEqual({
      error,
      ok: false,
      reason: "validation",
    });
    expect(openVerifiedFileSyncMock).not.toHaveBeenCalled();
  });

  it("guards against unexpected async sync-resolution results", () => {
    resolveBoundaryPathSyncMock.mockReturnValue(
      Promise.resolve({
        canonicalPath: "/real/plugin.json",
        rootCanonicalPath: "/real/root",
      }),
    );

    const opened = openBoundaryFileSync({
      absolutePath: "plugin.json",
      boundaryLabel: "plugin root",
      rootPath: "/workspace",
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) {
      return;
    }
    expect(opened.reason).toBe("validation");
    expect(String(opened.error)).toContain("Unexpected async boundary resolution");
  });

  it("awaits async boundary resolution before verifying the file", async () => {
    const ioFs = { marker: "io" } as never;
    const absolutePath = path.resolve("notes.txt");

    resolveBoundaryPathMock.mockResolvedValue({
      canonicalPath: "/real/notes.txt",
      rootCanonicalPath: "/real/root",
    });
    openVerifiedFileSyncMock.mockReturnValue({
      error: new Error("blocked"),
      ok: false,
      reason: "validation",
    });

    const opened = await openBoundaryFile({
      absolutePath: "notes.txt",
      aliasPolicy: { allowFinalSymlinkForUnlink: true },
      boundaryLabel: "workspace",
      ioFs,
      rootPath: "/workspace",
    });

    expect(resolveBoundaryPathMock).toHaveBeenCalledWith({
      absolutePath,
      boundaryLabel: "workspace",
      policy: { allowFinalSymlinkForUnlink: true },
      rootCanonicalPath: undefined,
      rootPath: "/workspace",
      skipLexicalRootCheck: undefined,
    });
    expect(openVerifiedFileSyncMock).toHaveBeenCalledWith({
      allowedType: undefined,
      filePath: absolutePath,
      ioFs,
      maxBytes: undefined,
      rejectHardlinks: true,
      resolvedPath: "/real/notes.txt",
    });
    expect(opened).toEqual({
      error: expect.any(Error),
      ok: false,
      reason: "validation",
    });
  });

  it("maps async boundary resolution failures to validation errors", async () => {
    const error = new Error("escaped");
    resolveBoundaryPathMock.mockRejectedValue(error);

    const opened = await openBoundaryFile({
      absolutePath: "notes.txt",
      boundaryLabel: "workspace",
      rootPath: "/workspace",
    });

    expect(opened).toEqual({
      error,
      ok: false,
      reason: "validation",
    });
    expect(openVerifiedFileSyncMock).not.toHaveBeenCalled();
  });

  it("matches boundary file failures by reason with fallback support", () => {
    const missing = matchBoundaryFileOpenFailure(
      { error: new Error("missing"), ok: false, reason: "path" },
      {
        fallback: () => "fallback",
        path: () => "missing",
      },
    );
    const io = matchBoundaryFileOpenFailure(
      { error: new Error("io"), ok: false, reason: "io" },
      {
        fallback: () => "fallback",
        io: () => "io",
      },
    );
    const validation = matchBoundaryFileOpenFailure(
      { error: new Error("blocked"), ok: false, reason: "validation" },
      {
        fallback: (failure) => failure.reason,
      },
    );

    expect(missing).toBe("missing");
    expect(io).toBe("io");
    expect(validation).toBe("validation");
  });
});
