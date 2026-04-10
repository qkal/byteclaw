import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => ({
    close: vi.fn(async () => undefined),
    on: vi.fn(),
  })),
}));

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ error: "sqlite-vec disabled in tests", ok: false }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    provider: {
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
      embedQuery: async () => [1, 0],
      id: "mock",
      model: "mock-embed",
    },
    requestedProvider: "openai",
  }),
}));

type MemoryIndexModule = typeof import("./index.js");
type MemoryEmbeddingProvidersModule =
  typeof import("../../../../src/plugins/memory-embedding-providers.js");

let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];
let clearRegistry: MemoryEmbeddingProvidersModule["clearMemoryEmbeddingProviders"];
let registerAdapter: MemoryEmbeddingProvidersModule["registerMemoryEmbeddingProvider"];

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";

  beforeAll(async () => {
    vi.resetModules();
    ({ getMemorySearchManager, closeAllMemorySearchManagers } = await import("./index.js"));
    ({
      clearMemoryEmbeddingProviders: clearRegistry,
      registerMemoryEmbeddingProvider: registerAdapter,
    } = await import("../../../../src/plugins/memory-embedding-providers.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    clearRegistry();
    registerBuiltInMemoryEmbeddingProviders({ registerMemoryEmbeddingProvider: registerAdapter });
  });

  afterEach(async () => {
    watchMock.mockClear();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    clearRegistry();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { force: true, recursive: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  afterAll(() => {
    vi.resetModules();
  });

  async function setupWatcherWorkspace(seedFile: { name: string; contents: string }) {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, seedFile.name), seedFile.contents);
  }

  function createWatcherConfig(overrides?: Partial<MemorySearchConfig>): OpenClawConfig {
    const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
      memorySearch: {
        extraPaths: [extraDir],
        model: "mock-embed",
        provider: "openai",
        query: { hybrid: { enabled: false }, minScore: 0 },
        store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
        sync: { onSearch: false, onSessionStart: false, watch: true, watchDebounceMs: 25 },
        ...overrides,
      },
      workspace: workspaceDir,
    };
    return {
      agents: {
        defaults,
        list: [{ default: true, id: "main" }],
      },
    } as OpenClawConfig;
  }

  async function expectWatcherManager(cfg: OpenClawConfig) {
    const result = await getMemorySearchManager({ agentId: "main", cfg });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
  }

  it("watches markdown globs and ignores dependency directories", async () => {
    await setupWatcherWorkspace({ contents: "hello", name: "notes.md" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toEqual(
      expect.arrayContaining([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "memory.md"),
        path.join(workspaceDir, "memory", "**", "*.md"),
        path.join(extraDir, "**", "*.md"),
      ]),
    );
    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ pollInterval: 100, stabilityThreshold: 25 });

    const ignored = options.ignored as ((watchPath: string) => boolean) | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"))).toBe(
      true,
    );
    expect(ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"))).toBe(false);
  });

  it("watches multimodal extensions with case-insensitive globs", async () => {
    await setupWatcherWorkspace({ contents: "png", name: "PHOTO.PNG" });
    const cfg = createWatcherConfig({
      fallback: "none",
      model: "gemini-embedding-2-preview",
      multimodal: { enabled: true, modalities: ["image", "audio"] },
      provider: "gemini",
    });

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toEqual(
      expect.arrayContaining([
        path.join(extraDir, "**", "*.[pP][nN][gG]"),
        path.join(extraDir, "**", "*.[wW][aA][vV]"),
      ]),
    );
  });
});
