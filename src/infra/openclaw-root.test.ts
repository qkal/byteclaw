import actualFs from "node:fs";
import actualFsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeFsEntry = { kind: "file"; content: string } | { kind: "dir" };

const VITEST_FS_BASE = path.join(path.parse(process.cwd()).root, "__openclaw_vitest__");
const FIXTURE_BASE = path.join(VITEST_FS_BASE, "openclaw-root");

const state = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  realpathErrors: new Set<string>(),
  realpaths: new Map<string, string>(),
}));

const abs = (p: string) => path.resolve(p);
const fx = (...parts: string[]) => path.join(FIXTURE_BASE, ...parts);
const vitestRootWithSep = `${abs(VITEST_FS_BASE)}${path.sep}`;
const isFixturePath = (p: string) => {
  const resolved = abs(p);
  return resolved === vitestRootWithSep.slice(0, -1) || resolved.startsWith(vitestRootWithSep);
};

function setFile(p: string, content = "") {
  state.entries.set(abs(p), { content, kind: "file" });
}

function setPackageRoot(root: string, name = "openclaw") {
  setFile(path.join(root, "package.json"), JSON.stringify({ name }));
}

function expectResolvedPackageRoot(
  syncResolver: typeof import("./openclaw-root.js").resolveOpenClawPackageRootSync,
  asyncResolver: typeof import("./openclaw-root.js").resolveOpenClawPackageRoot,
  opts: Parameters<typeof import("./openclaw-root.js").resolveOpenClawPackageRootSync>[0],
  expected: string | null,
) {
  expect(syncResolver(opts)).toBe(expected);
  return expect(asyncResolver(opts)).resolves.toBe(expected);
}

const mockFsModule = () => {
  const wrapped = {
    ...actualFs,
    existsSync: (p: string) =>
      isFixturePath(p) ? state.entries.has(abs(p)) : actualFs.existsSync(p),
    readFileSync: (p: string, encoding?: BufferEncoding) => {
      if (!isFixturePath(p)) {
        return actualFs.readFileSync(p, encoding);
      }
      const entry = state.entries.get(abs(p));
      if (!entry || entry.kind !== "file") {
        throw new Error(`ENOENT: no such file, open '${p}'`);
      }
      return encoding ? entry.content : Buffer.from(entry.content, "utf8");
    },
    realpathSync: (p: string) =>
      isFixturePath(p)
        ? (() => {
            const resolved = abs(p);
            if (state.realpathErrors.has(resolved)) {
              throw new Error(`ENOENT: no such file or directory, realpath '${p}'`);
            }
            return state.realpaths.get(resolved) ?? resolved;
          })()
        : actualFs.realpathSync(p),
    statSync: (p: string) => {
      if (!isFixturePath(p)) {
        return actualFs.statSync(p);
      }
      const entry = state.entries.get(abs(p));
      if (!entry) {
        throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
      }
      return {
        isDirectory: () => entry.kind === "dir",
        isFile: () => entry.kind === "file",
      };
    },
  };
  return wrapped;
};

const mockFsPromisesModule = () => {
  const wrapped = {
    ...actualFsPromises,
    readFile: async (p: string, encoding?: BufferEncoding) => {
      if (!isFixturePath(p)) {
        return await actualFsPromises.readFile(p, encoding);
      }
      const entry = state.entries.get(abs(p));
      if (!entry || entry.kind !== "file") {
        throw new Error(`ENOENT: no such file, open '${p}'`);
      }
      return entry.content;
    },
  };
  return wrapped;
};

vi.mock("./openclaw-root.fs.runtime.js", () => ({
  openClawRootFs: mockFsPromisesModule(),
  openClawRootFsSync: mockFsModule(),
}));

describe("resolveOpenClawPackageRoot", () => {
  let resolveOpenClawPackageRoot: typeof import("./openclaw-root.js").resolveOpenClawPackageRoot;
  let resolveOpenClawPackageRootSync: typeof import("./openclaw-root.js").resolveOpenClawPackageRootSync;

  beforeEach(() => {
    state.entries.clear();
    state.realpaths.clear();
    state.realpathErrors.clear();
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } =
      await import("./openclaw-root.js"));
  });

  it.each([
    {
      name: "resolves package root from .bin argv1",
      setup: () => {
        const project = fx("bin-scenario");
        const argv1 = path.join(project, "node_modules", ".bin", "openclaw");
        const pkgRoot = path.join(project, "node_modules", "openclaw");
        setPackageRoot(pkgRoot);
        return { expected: pkgRoot, opts: { argv1 } };
      },
    },
    {
      name: "resolves package root via symlinked argv1",
      setup: () => {
        const project = fx("symlink-scenario");
        const bin = path.join(project, "bin", "openclaw");
        const realPkg = path.join(project, "real-pkg");
        state.realpaths.set(abs(bin), abs(path.join(realPkg, "openclaw.mjs")));
        setPackageRoot(realPkg);
        return { expected: realPkg, opts: { argv1: bin } };
      },
    },
    {
      name: "falls back when argv1 realpath throws",
      setup: () => {
        const project = fx("realpath-throw-scenario");
        const argv1 = path.join(project, "node_modules", ".bin", "openclaw");
        const pkgRoot = path.join(project, "node_modules", "openclaw");
        state.realpathErrors.add(abs(argv1));
        setPackageRoot(pkgRoot);
        return { expected: pkgRoot, opts: { argv1 } };
      },
    },
    {
      name: "prefers moduleUrl candidates",
      setup: () => {
        const pkgRoot = fx("moduleurl");
        setPackageRoot(pkgRoot);
        return {
          expected: pkgRoot,
          opts: { moduleUrl: pathToFileURL(path.join(pkgRoot, "dist", "index.js")).toString() },
        };
      },
    },
    {
      name: "falls through from a non-openclaw moduleUrl candidate to cwd",
      setup: () => {
        const wrongPkgRoot = fx("moduleurl-fallthrough", "wrong");
        const cwdPkgRoot = fx("moduleurl-fallthrough", "cwd");
        setPackageRoot(wrongPkgRoot, "not-openclaw");
        setPackageRoot(cwdPkgRoot);
        return {
          expected: cwdPkgRoot,
          opts: {
            cwd: cwdPkgRoot,
            moduleUrl: pathToFileURL(path.join(wrongPkgRoot, "dist", "index.js")).toString(),
          },
        };
      },
    },
    {
      name: "ignores invalid moduleUrl values and falls back to cwd",
      setup: () => {
        const pkgRoot = fx("invalid-moduleurl");
        setPackageRoot(pkgRoot);
        return {
          expected: pkgRoot,
          opts: { cwd: pkgRoot, moduleUrl: "not-a-file-url" },
        };
      },
    },
    {
      name: "returns null for non-openclaw package roots",
      setup: () => {
        const pkgRoot = fx("not-openclaw");
        setPackageRoot(pkgRoot, "not-openclaw");
        return { expected: null, opts: { cwd: pkgRoot } };
      },
    },
    {
      name: "falls back from a symlinked argv1 to the node_modules package root",
      setup: () => {
        const project = fx("symlink-node-modules-fallback");
        const argv1 = path.join(project, "node_modules", ".bin", "openclaw");
        state.realpaths.set(
          abs(argv1),
          abs(path.join(project, "versions", "current", "openclaw.mjs")),
        );
        const pkgRoot = path.join(project, "node_modules", "openclaw");
        setPackageRoot(pkgRoot);
        return { expected: pkgRoot, opts: { argv1 } };
      },
    },
    {
      name: "returns null when no package roots exist",
      setup: () => ({
        expected: null,
        opts: { cwd: fx("missing") },
      }),
    },
  ])("$name", async ({ setup }) => {
    const { opts, expected } = setup();
    await expectResolvedPackageRoot(
      resolveOpenClawPackageRootSync,
      resolveOpenClawPackageRoot,
      opts,
      expected,
    );
  });
});
