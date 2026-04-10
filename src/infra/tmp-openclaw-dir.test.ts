import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { POSIX_OPENCLAW_TMP_DIR, resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

type TmpDirOptions = NonNullable<Parameters<typeof resolvePreferredOpenClawTmpDir>[0]>;

function fallbackTmp(uid = 501) {
  return path.join("/var/fallback", `openclaw-${uid}`);
}

function nodeErrorWithCode(code: string) {
  const err = new Error(code) as Error & { code?: string };
  err.code = code;
  return err;
}

function secureDirStat(uid = 501) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode: 0o4_0700,
    uid,
  };
}

function makeDirStat(params?: {
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  uid?: number;
  mode?: number;
}) {
  return {
    isDirectory: () => params?.isDirectory ?? true,
    isSymbolicLink: () => params?.isSymbolicLink ?? false,
    mode: params?.mode ?? 0o4_0700,
    uid: params?.uid ?? 501,
  };
}

function readOnlyTmpAccessSync() {
  return vi.fn((target: string) => {
    if (target === "/tmp") {
      throw new Error("read-only");
    }
  });
}

function resolveWithReadOnlyTmpFallback(params: {
  fallbackPath: string;
  fallbackLstatSync: NonNullable<TmpDirOptions["lstatSync"]>;
  chmodSync?: NonNullable<TmpDirOptions["chmodSync"]>;
  warn?: NonNullable<TmpDirOptions["warn"]>;
}) {
  return resolvePreferredOpenClawTmpDir({
    accessSync: readOnlyTmpAccessSync(),
    chmodSync: params.chmodSync,
    getuid: vi.fn(() => 501),
    lstatSync: vi.fn((target: string) => {
      if (target === POSIX_OPENCLAW_TMP_DIR) {
        throw nodeErrorWithCode("ENOENT");
      }
      if (target === params.fallbackPath) {
        return params.fallbackLstatSync(target);
      }
      return secureDirStat(501);
    }),
    mkdirSync: vi.fn(),
    tmpdir: vi.fn(() => "/var/fallback"),
    warn: params.warn,
  });
}

function symlinkTmpDirLstat() {
  return vi.fn(() => makeDirStat({ isSymbolicLink: true, mode: 0o12_0777 }));
}

function expectFallsBackToOsTmpDir(params: { lstatSync: NonNullable<TmpDirOptions["lstatSync"]> }) {
  const { resolved, tmpdir } = resolveWithMocks({ lstatSync: params.lstatSync });
  expect(resolved).toBe(fallbackTmp());
  expect(tmpdir).toHaveBeenCalled();
}

function expectResolvesFallbackTmpDir(params: {
  lstatSync: NonNullable<TmpDirOptions["lstatSync"]>;
  accessSync?: NonNullable<TmpDirOptions["accessSync"]>;
}) {
  const { resolved, tmpdir } = resolveWithMocks({
    lstatSync: params.lstatSync,
    ...(params.accessSync ? { accessSync: params.accessSync } : {}),
  });
  expect(resolved).toBe(fallbackTmp());
  expect(tmpdir).toHaveBeenCalled();
}

function missingThenSecureLstat(uid = 501) {
  return vi
    .fn<NonNullable<TmpDirOptions["lstatSync"]>>()
    .mockImplementationOnce(() => {
      throw nodeErrorWithCode("ENOENT");
    })
    .mockImplementationOnce(() => secureDirStat(uid));
}

function resolveWithMocks(params: {
  lstatSync: NonNullable<TmpDirOptions["lstatSync"]>;
  fallbackLstatSync?: NonNullable<TmpDirOptions["lstatSync"]>;
  accessSync?: NonNullable<TmpDirOptions["accessSync"]>;
  chmodSync?: NonNullable<TmpDirOptions["chmodSync"]>;
  warn?: NonNullable<TmpDirOptions["warn"]>;
  uid?: number;
  tmpdirPath?: string;
}) {
  const uid = params.uid ?? 501;
  const fallbackPath = fallbackTmp(uid);
  const accessSync = params.accessSync ?? vi.fn();
  const chmodSync = params.chmodSync ?? vi.fn();
  const warn = params.warn ?? vi.fn();
  const wrappedLstatSync = vi.fn((target: string) => {
    if (target === POSIX_OPENCLAW_TMP_DIR) {
      return params.lstatSync(target);
    }
    if (target === fallbackPath) {
      if (params.fallbackLstatSync) {
        return params.fallbackLstatSync(target);
      }
      return secureDirStat(uid);
    }
    return secureDirStat(uid);
  }) as NonNullable<TmpDirOptions["lstatSync"]>;
  const mkdirSync = vi.fn();
  const getuid = vi.fn(() => uid);
  const tmpdir = vi.fn(() => params.tmpdirPath ?? "/var/fallback");
  const resolved = resolvePreferredOpenClawTmpDir({
    accessSync,
    chmodSync,
    getuid,
    lstatSync: wrappedLstatSync,
    mkdirSync,
    tmpdir,
    warn,
  });
  return { accessSync, lstatSync: wrappedLstatSync, mkdirSync, resolved, tmpdir };
}

describe("resolvePreferredOpenClawTmpDir", () => {
  it("prefers /tmp/openclaw when it already exists and is writable", () => {
    const lstatSync: NonNullable<TmpDirOptions["lstatSync"]> = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o4_0700,
      uid: 501,
    }));
    const { resolved, accessSync, tmpdir } = resolveWithMocks({ lstatSync });

    expect(lstatSync).toHaveBeenCalledTimes(1);
    expect(accessSync).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(POSIX_OPENCLAW_TMP_DIR);
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("prefers /tmp/openclaw when it does not exist but /tmp is writable", () => {
    const lstatSyncMock = missingThenSecureLstat();

    const { resolved, accessSync, mkdirSync, tmpdir } = resolveWithMocks({
      lstatSync: lstatSyncMock,
    });

    expect(resolved).toBe(POSIX_OPENCLAW_TMP_DIR);
    expect(accessSync).toHaveBeenCalledWith("/tmp", expect.any(Number));
    expect(mkdirSync).toHaveBeenCalledWith(POSIX_OPENCLAW_TMP_DIR, expect.any(Object));
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it.each([
    {
      lstatSync: vi.fn(() => makeDirStat({ isDirectory: false, mode: 0o10_0644 })),
      name: "falls back to os.tmpdir()/openclaw when /tmp/openclaw is not a directory",
    },
    {
      accessSync: vi.fn((target: string) => {
        if (target === "/tmp") {
          throw new Error("read-only");
        }
      }),
      lstatSync: vi.fn(() => {
        throw nodeErrorWithCode("ENOENT");
      }),
      name: "falls back to os.tmpdir()/openclaw when /tmp is not writable",
    },
    {
      accessSync: vi.fn((target: string) => {
        if (target === POSIX_OPENCLAW_TMP_DIR) {
          throw new Error("not writable");
        }
      }),
      lstatSync: vi.fn(() => secureDirStat()),
      name: "falls back when /tmp/openclaw exists but is not writable",
    },
    {
      lstatSync: symlinkTmpDirLstat(),
      name: "falls back when /tmp/openclaw is a symlink",
    },
    {
      lstatSync: vi.fn(() => makeDirStat({ uid: 0 })),
      name: "falls back when /tmp/openclaw is not owned by the current user",
    },
    {
      lstatSync: vi.fn(() => makeDirStat({ mode: 0o4_0777 })),
      name: "falls back when /tmp/openclaw is group/other writable",
    },
  ])("$name", ({ lstatSync, accessSync }) => {
    if (accessSync) {
      expectResolvesFallbackTmpDir({ accessSync, lstatSync });
      return;
    }
    expectFallsBackToOsTmpDir({ lstatSync });
  });

  it("repairs existing /tmp/openclaw permissions when they are too broad", () => {
    let preferredMode = 0o4_0777;
    const chmodSync = vi.fn((target: string, mode: number) => {
      if (target === POSIX_OPENCLAW_TMP_DIR && mode === 0o700) {
        preferredMode = 0o4_0700;
      }
    });
    const warn = vi.fn();

    const { resolved, tmpdir } = resolveWithMocks({
      chmodSync,
      lstatSync: vi.fn(() => makeDirStat({ mode: preferredMode })),
      warn,
    });

    expect(resolved).toBe(POSIX_OPENCLAW_TMP_DIR);
    expect(chmodSync).toHaveBeenCalledWith(POSIX_OPENCLAW_TMP_DIR, 0o700);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tightened permissions on temp dir"));
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("repairs /tmp/openclaw after create when the initial mode stays too broad", () => {
    let preferredMode = 0o4_0775;
    let chmodCalls = 0;
    const lstatSync = vi
      .fn<NonNullable<TmpDirOptions["lstatSync"]>>()
      .mockImplementationOnce(() => {
        throw nodeErrorWithCode("ENOENT");
      })
      .mockImplementation(() =>
        makeDirStat({
          mode: preferredMode,
        }),
      );
    const chmodSync = vi.fn((target: string, mode: number) => {
      chmodCalls += 1;
      if (target === POSIX_OPENCLAW_TMP_DIR && mode === 0o700 && chmodCalls > 1) {
        preferredMode = 0o4_0700;
      }
    });
    const warn = vi.fn();

    const { resolved, mkdirSync, tmpdir } = resolveWithMocks({
      chmodSync,
      lstatSync,
      warn,
    });

    expect(resolved).toBe(POSIX_OPENCLAW_TMP_DIR);
    expect(mkdirSync).toHaveBeenCalledWith(POSIX_OPENCLAW_TMP_DIR, {
      mode: 0o700,
      recursive: true,
    });
    expect(chmodSync).toHaveBeenCalledWith(POSIX_OPENCLAW_TMP_DIR, 0o700);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tightened permissions on temp dir"));
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("throws when fallback path is a symlink", () => {
    const lstatSync = symlinkTmpDirLstat();
    const fallbackLstatSync = vi.fn(() => makeDirStat({ isSymbolicLink: true, mode: 0o12_0777 }));

    expect(() =>
      resolveWithMocks({
        fallbackLstatSync,
        lstatSync,
      }),
    ).toThrow(/Unsafe fallback OpenClaw temp dir/);
  });

  it("creates fallback directory when missing, then validates ownership and mode", () => {
    const lstatSync = symlinkTmpDirLstat();
    const fallbackLstatSync = missingThenSecureLstat();

    const { resolved, mkdirSync } = resolveWithMocks({
      fallbackLstatSync,
      lstatSync,
    });

    expect(resolved).toBe(fallbackTmp());
    expect(mkdirSync).toHaveBeenCalledWith(fallbackTmp(), { mode: 0o700, recursive: true });
  });

  it("uses an unscoped fallback suffix when process uid is unavailable", () => {
    const tmpdirPath = "/var/fallback";
    const fallbackPath = path.join(tmpdirPath, "openclaw");

    const resolved = resolvePreferredOpenClawTmpDir({
      accessSync: vi.fn((target: string) => {
        if (target === "/tmp") {
          throw new Error("read-only");
        }
      }),
      chmodSync: vi.fn(),
      getuid: vi.fn(() => undefined),
      lstatSync: vi.fn((target: string) => {
        if (target === POSIX_OPENCLAW_TMP_DIR) {
          throw nodeErrorWithCode("ENOENT");
        }
        if (target === fallbackPath) {
          return makeDirStat({ mode: 0o40777, uid: 0 });
        }
        return secureDirStat();
      }),
      mkdirSync: vi.fn(),
      tmpdir: vi.fn(() => tmpdirPath),
      warn: vi.fn(),
    });

    expect(resolved).toBe(fallbackPath);
  });

  it("repairs fallback directory permissions after create when umask makes it group-writable", () => {
    const fallbackPath = fallbackTmp();
    let fallbackMode = 0o4_0775;
    const lstatSync = vi.fn<NonNullable<TmpDirOptions["lstatSync"]>>(() => {
      throw nodeErrorWithCode("ENOENT");
    });
    const fallbackLstatSync = vi
      .fn<NonNullable<TmpDirOptions["lstatSync"]>>()
      .mockImplementationOnce(() => {
        throw nodeErrorWithCode("ENOENT");
      })
      .mockImplementation(() => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: fallbackMode,
        uid: 501,
      }));
    const chmodSync = vi.fn((target: string, mode: number) => {
      if (target === fallbackPath && mode === 0o700) {
        fallbackMode = 0o4_0700;
      }
    });

    const resolved = resolveWithReadOnlyTmpFallback({
      chmodSync,
      fallbackLstatSync: vi.fn((target: string) => {
        if (target === fallbackPath) {
          return fallbackLstatSync(target);
        }
        return lstatSync(target);
      }),
      fallbackPath,
      warn: vi.fn(),
    });

    expect(resolved).toBe(fallbackPath);
    expect(chmodSync).toHaveBeenCalledWith(fallbackPath, 0o700);
  });

  it("repairs existing fallback directory when permissions are too broad", () => {
    const fallbackPath = fallbackTmp();
    let fallbackMode = 0o4_0775;
    const chmodSync = vi.fn((target: string, mode: number) => {
      if (target === fallbackPath && mode === 0o700) {
        fallbackMode = 0o4_0700;
      }
    });
    const warn = vi.fn();

    const resolved = resolveWithReadOnlyTmpFallback({
      chmodSync,
      fallbackLstatSync: vi.fn(() =>
        makeDirStat({
          isSymbolicLink: false,
          mode: fallbackMode,
        }),
      ),
      fallbackPath,
      warn,
    });

    expect(resolved).toBe(fallbackPath);
    expect(chmodSync).toHaveBeenCalledWith(fallbackPath, 0o700);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tightened permissions on temp dir"));
  });

  it("throws when the fallback directory cannot be created", () => {
    expect(() =>
      resolvePreferredOpenClawTmpDir({
        accessSync: readOnlyTmpAccessSync(),
        chmodSync: vi.fn(),
        getuid: vi.fn(() => 501),
        lstatSync: vi.fn((target: string) => {
          if (target === POSIX_OPENCLAW_TMP_DIR || target === fallbackTmp()) {
            throw nodeErrorWithCode("ENOENT");
          }
          return secureDirStat();
        }),
        mkdirSync: vi.fn(() => {
          throw new Error("mkdir failed");
        }),
        tmpdir: vi.fn(() => "/var/fallback"),
        warn: vi.fn(),
      }),
    ).toThrow(/Unable to create fallback OpenClaw temp dir/);
  });
});
