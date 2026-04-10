import { beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPluginRootAt } from "../../test/helpers/bundled-plugin-paths.js";
import {
  findBundledPluginSource,
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
} from "./bundled-sources.js";

const APP_ROOT = "/app";

function appBundledPluginRoot(pluginId: string): string {
  return bundledPluginRootAt(APP_ROOT, pluginId);
}

const discoverOpenClawPluginsMock = vi.fn();
const loadPluginManifestMock = vi.fn();

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: (...args: unknown[]) => discoverOpenClawPluginsMock(...args),
}));

vi.mock("./manifest.js", () => ({
  loadPluginManifest: (...args: unknown[]) => loadPluginManifestMock(...args),
}));

function createBundledCandidate(params: {
  rootDir: string;
  packageName: string;
  npmSpec?: string;
  origin?: "bundled" | "global";
}) {
  return {
    origin: params.origin ?? "bundled",
    packageManifest: {
      install: {
        npmSpec: params.npmSpec ?? params.packageName,
      },
    },
    packageName: params.packageName,
    rootDir: params.rootDir,
  };
}

function setBundledDiscoveryCandidates(candidates: unknown[]) {
  discoverOpenClawPluginsMock.mockReturnValue({
    candidates,
    diagnostics: [],
  });
}

function setBundledManifestIdsByRoot(manifestIds: Record<string, string>) {
  loadPluginManifestMock.mockImplementation((rootDir: string) =>
    rootDir in manifestIds
      ? { manifest: { id: manifestIds[rootDir] }, ok: true }
      : {
          error: "invalid manifest",
          manifestPath: `${rootDir}/openclaw.plugin.json`,
          ok: false,
        },
  );
}

function setBundledLookupFixture() {
  setBundledDiscoveryCandidates([
    createBundledCandidate({
      packageName: "@openclaw/feishu",
      rootDir: appBundledPluginRoot("feishu"),
    }),
    createBundledCandidate({
      packageName: "@openclaw/diffs",
      rootDir: appBundledPluginRoot("diffs"),
    }),
  ]);
  setBundledManifestIdsByRoot({
    [appBundledPluginRoot("feishu")]: "feishu",
    [appBundledPluginRoot("diffs")]: "diffs",
  });
}

function createResolvedBundledSource(params: {
  pluginId: string;
  localPath: string;
  npmSpec?: string;
}) {
  return {
    localPath: params.localPath,
    npmSpec: params.npmSpec ?? `@openclaw/${params.pluginId}`,
    pluginId: params.pluginId,
  };
}

function expectBundledSourceLookup(
  lookup: Parameters<typeof findBundledPluginSource>[0]["lookup"],
  expected:
    | {
        pluginId: string;
        localPath: string;
      }
    | undefined,
) {
  const resolved = findBundledPluginSource({ lookup });
  if (!expected) {
    expect(resolved).toBeUndefined();
    return;
  }
  expect(resolved?.pluginId).toBe(expected.pluginId);
  expect(resolved?.localPath).toBe(expected.localPath);
}

function expectBundledSourceLookupCase(params: {
  lookup: Parameters<typeof findBundledPluginSource>[0]["lookup"];
  expected:
    | {
        pluginId: string;
        localPath: string;
      }
    | undefined;
}) {
  setBundledLookupFixture();
  expectBundledSourceLookup(params.lookup, params.expected);
}

describe("bundled plugin sources", () => {
  beforeEach(() => {
    discoverOpenClawPluginsMock.mockReset();
    loadPluginManifestMock.mockReset();
  });

  it("resolves bundled sources keyed by plugin id", () => {
    setBundledDiscoveryCandidates([
      createBundledCandidate({
        origin: "global",
        packageName: "@openclaw/feishu",
        rootDir: "/global/feishu",
      }),
      createBundledCandidate({
        packageName: "@openclaw/feishu",
        rootDir: appBundledPluginRoot("feishu"),
      }),
      createBundledCandidate({
        packageName: "@openclaw/feishu",
        rootDir: appBundledPluginRoot("feishu-dup"),
      }),
      createBundledCandidate({
        packageName: "@openclaw/msteams",
        rootDir: appBundledPluginRoot("msteams"),
      }),
    ]);
    setBundledManifestIdsByRoot({
      [appBundledPluginRoot("feishu")]: "feishu",
      [appBundledPluginRoot("msteams")]: "msteams",
    });

    const map = resolveBundledPluginSources({});

    expect([...map.keys()]).toEqual(["feishu", "msteams"]);
    expect(map.get("feishu")).toEqual(
      createResolvedBundledSource({
        localPath: appBundledPluginRoot("feishu"),
        pluginId: "feishu",
      }),
    );
  });

  it.each([
    [
      "finds bundled source by npm spec",
      { kind: "npmSpec", value: "@openclaw/feishu" } as const,
      { localPath: appBundledPluginRoot("feishu"), pluginId: "feishu" },
    ],
    [
      "returns undefined for missing npm spec",
      { kind: "npmSpec", value: "@openclaw/not-found" } as const,
      undefined,
    ],
    [
      "finds bundled source by plugin id",
      { kind: "pluginId", value: "diffs" } as const,
      { localPath: appBundledPluginRoot("diffs"), pluginId: "diffs" },
    ],
    [
      "returns undefined for missing plugin id",
      { kind: "pluginId", value: "not-found" } as const,
      undefined,
    ],
  ] as const)("%s", (_name, lookup, expected) => {
    expectBundledSourceLookupCase({ expected, lookup });
  });

  it("forwards an explicit env to bundled discovery helpers", () => {
    setBundledDiscoveryCandidates([]);

    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    resolveBundledPluginSources({
      env,
      workspaceDir: "/workspace",
    });
    findBundledPluginSource({
      env,
      lookup: { kind: "pluginId", value: "feishu" },
      workspaceDir: "/workspace",
    });

    expect(discoverOpenClawPluginsMock).toHaveBeenNthCalledWith(1, {
      env,
      workspaceDir: "/workspace",
    });
    expect(discoverOpenClawPluginsMock).toHaveBeenNthCalledWith(2, {
      env,
      workspaceDir: "/workspace",
    });
  });

  it("reuses a pre-resolved bundled map for repeated lookups", () => {
    const bundled = new Map([
      [
        "feishu",
        createResolvedBundledSource({
          localPath: appBundledPluginRoot("feishu"),
          pluginId: "feishu",
        }),
      ],
    ]);

    expect(
      findBundledPluginSourceInMap({
        bundled,
        lookup: { kind: "pluginId", value: "feishu" },
      }),
    ).toEqual(
      createResolvedBundledSource({
        localPath: appBundledPluginRoot("feishu"),
        pluginId: "feishu",
      }),
    );
    expect(
      findBundledPluginSourceInMap({
        bundled,
        lookup: { kind: "npmSpec", value: "@openclaw/feishu" },
      })?.pluginId,
    ).toBe("feishu");
  });
});
