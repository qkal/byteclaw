import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { checkQmdBinaryAvailability as checkQmdBinaryAvailabilityFn } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CheckQmdBinaryAvailability = typeof checkQmdBinaryAvailabilityFn;

function createManagerStatus(params: {
  backend: "qmd" | "builtin";
  provider: string;
  model: string;
  requestedProvider: string;
  withMemorySourceCounts?: boolean;
}) {
  const base = {
    backend: params.backend,
    chunks: 0,
    dbPath: "/tmp/index.sqlite",
    dirty: false,
    files: 0,
    model: params.model,
    provider: params.provider,
    requestedProvider: params.requestedProvider,
    workspaceDir: "/tmp",
  };
  if (!params.withMemorySourceCounts) {
    return base;
  }
  return {
    ...base,
    sourceCounts: [{ chunks: 0, files: 0, source: "memory" as const }],
    sources: ["memory" as const],
  };
}

function createManagerMock(params: {
  backend: "qmd" | "builtin";
  provider: string;
  model: string;
  requestedProvider: string;
  searchResults?: {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: "memory";
  }[];
  withMemorySourceCounts?: boolean;
}) {
  return {
    close: vi.fn(async () => {}),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => true),
    readFile: vi.fn(async () => ({ path: "MEMORY.md", text: "" })),
    search: vi.fn(async () => params.searchResults ?? []),
    status: vi.fn(() =>
      createManagerStatus({
        backend: params.backend,
        model: params.model,
        provider: params.provider,
        requestedProvider: params.requestedProvider,
        withMemorySourceCounts: params.withMemorySourceCounts,
      }),
    ),
    sync: vi.fn(async () => {}),
  };
}

const mockPrimary = vi.hoisted(() => ({
  ...createManagerMock({
    backend: "qmd",
    model: "qmd",
    provider: "qmd",
    requestedProvider: "qmd",
    withMemorySourceCounts: true,
  }),
}));

const fallbackManager = vi.hoisted(() => ({
  ...createManagerMock({
    backend: "builtin",
    model: "text-embedding-3-small",
    provider: "openai",
    requestedProvider: "openai",
    searchResults: [
      {
        endLine: 1,
        path: "MEMORY.md",
        score: 1,
        snippet: "fallback",
        source: "memory",
        startLine: 1,
      },
    ],
  }),
}));

const fallbackSearch = fallbackManager.search;
const mockMemoryIndexGet = vi.hoisted(() => vi.fn(async () => fallbackManager));
const mockCloseAllMemoryIndexManagers = vi.hoisted(() => vi.fn(async () => {}));
const checkQmdBinaryAvailability = vi.hoisted(() =>
  vi.fn<CheckQmdBinaryAvailability>(async () => ({ available: true })),
);

vi.mock("./qmd-manager.js", () => ({
  QmdMemoryManager: {
    create: vi.fn(async () => mockPrimary),
  },
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  checkQmdBinaryAvailability,
}));

vi.mock("../../manager-runtime.js", () => ({
  MemoryIndexManager: {
    get: mockMemoryIndexGet,
  },
  closeAllMemoryIndexManagers: mockCloseAllMemoryIndexManagers,
}));

import { QmdMemoryManager } from "./qmd-manager.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./search-manager.js";
const createQmdManagerMock = vi.mocked(QmdMemoryManager.create);

type SearchManagerResult = Awaited<ReturnType<typeof getMemorySearchManager>>;
type SearchManager = NonNullable<SearchManagerResult["manager"]>;

function createQmdCfg(agentId: string): OpenClawConfig {
  return {
    agents: { list: [{ default: true, id: agentId, workspace: "/tmp/workspace" }] },
    memory: { backend: "qmd", qmd: {} },
  };
}

function createBuiltinCfg(agentId: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        memorySearch: {
          experimental: { sessionMemory: false },
          model: "text-embedding-3-small",
          provider: "openai",
          query: { hybrid: { enabled: false }, minScore: 0 },
          sources: ["memory"],
          store: {
            path: "/tmp/index.sqlite",
            vector: { enabled: false },
          },
          sync: { onSearch: false, onSessionStart: false, watch: false },
        },
        workspace: "/tmp/workspace",
      },
      list: [{ default: true, id: agentId, workspace: "/tmp/workspace" }],
    },
  } as OpenClawConfig;
}

function requireManager(result: SearchManagerResult): SearchManager {
  expect(result.manager).toBeTruthy();
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager;
}

async function createFailedQmdSearchHarness(params: { agentId: string; errorMessage: string }) {
  const cfg = createQmdCfg(params.agentId);
  mockPrimary.search.mockRejectedValueOnce(new Error(params.errorMessage));
  const first = await getMemorySearchManager({ agentId: params.agentId, cfg });
  return { cfg, firstResult: first, manager: requireManager(first) };
}

beforeEach(async () => {
  await closeAllMemorySearchManagers();
  mockPrimary.search.mockClear();
  mockPrimary.readFile.mockClear();
  mockPrimary.status.mockClear();
  mockPrimary.sync.mockClear();
  mockPrimary.probeEmbeddingAvailability.mockClear();
  mockPrimary.probeVectorAvailability.mockClear();
  mockPrimary.close.mockClear();
  fallbackSearch.mockClear();
  fallbackManager.readFile.mockClear();
  fallbackManager.status.mockClear();
  fallbackManager.sync.mockClear();
  fallbackManager.probeEmbeddingAvailability.mockClear();
  fallbackManager.probeVectorAvailability.mockClear();
  fallbackManager.close.mockClear();
  mockCloseAllMemoryIndexManagers.mockClear();
  mockMemoryIndexGet.mockClear();
  mockMemoryIndexGet.mockResolvedValue(fallbackManager);
  checkQmdBinaryAvailability.mockClear();
  checkQmdBinaryAvailability.mockResolvedValue({ available: true });
  createQmdManagerMock.mockClear();
});

describe("getMemorySearchManager caching", () => {
  it("reuses the same QMD manager instance for repeated calls", async () => {
    const cfg = createQmdCfg("main");

    const first = await getMemorySearchManager({ agentId: "main", cfg });
    const second = await getMemorySearchManager({ agentId: "main", cfg });

    expect(first.manager).toBe(second.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(1);
  });

  it("evicts failed qmd wrapper so next call retries qmd", async () => {
    const retryAgentId = "retry-agent";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });

    const fallbackResults = await firstManager.search("hello");
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0]?.path).toBe("MEMORY.md");

    const second = await getMemorySearchManager({ agentId: retryAgentId, cfg });
    requireManager(second);
    expect(second.manager).not.toBe(first.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("falls back immediately when the qmd binary is unavailable", async () => {
    const cfg = createQmdCfg("missing-qmd");
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      error: "spawn qmd ENOENT",
    });

    const result = await getMemorySearchManager({ agentId: "missing-qmd", cfg });
    const manager = requireManager(result);
    const searchResults = await manager.search("hello");

    expect(createQmdManagerMock).not.toHaveBeenCalled();
    expect(mockMemoryIndexGet).toHaveBeenCalled();
    expect(searchResults).toHaveLength(1);
  });

  it("probes qmd availability from the agent workspace", async () => {
    const agentId = "workspace-probe";
    const cfg = createQmdCfg(agentId);

    await getMemorySearchManager({ agentId, cfg });

    expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
      command: "qmd",
      cwd: "/tmp/workspace",
      env: process.env,
    });
  });

  it("returns a cached qmd manager without probing the binary again", async () => {
    const agentId = "cached-qmd";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ agentId, cfg });
    const second = await getMemorySearchManager({ agentId, cfg });

    requireManager(first);
    requireManager(second);
    expect(first.manager).toBe(second.manager);
    expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
  });

  it("does not cache qmd managers for status-only requests", async () => {
    const agentId = "status-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ agentId, cfg, purpose: "status" });
    const second = await getMemorySearchManager({ agentId, cfg, purpose: "status" });

    requireManager(first);
    requireManager(second);
    expect(first.manager?.status()).toMatchObject({
      backend: "qmd",
      model: "qmd",
      provider: "qmd",
      requestedProvider: "qmd",
    });
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();

    await first.manager?.close?.();
    await second.manager?.close?.();
    expect(mockPrimary.close).toHaveBeenCalledTimes(2);
  });

  it("does not cache builtin managers for status-only requests", async () => {
    const agentId = "builtin-status-agent";
    const cfg = createBuiltinCfg(agentId);
    const firstBuiltinManager = createManagerMock({
      backend: "builtin",
      model: "text-embedding-3-small",
      provider: "openai",
      requestedProvider: "openai",
    });
    const secondBuiltinManager = createManagerMock({
      backend: "builtin",
      model: "text-embedding-3-small",
      provider: "openai",
      requestedProvider: "openai",
    });
    mockMemoryIndexGet
      .mockResolvedValueOnce(firstBuiltinManager)
      .mockResolvedValueOnce(secondBuiltinManager);

    const first = await getMemorySearchManager({ agentId, cfg, purpose: "status" });
    const second = await getMemorySearchManager({ agentId, cfg, purpose: "status" });

    expect(first.manager).toBe(firstBuiltinManager);
    expect(second.manager).toBe(secondBuiltinManager);
    expect(second.manager).not.toBe(first.manager);
    expect(mockMemoryIndexGet).toHaveBeenCalledTimes(2);

    await first.manager?.close?.();
    await second.manager?.close?.();
    expect(firstBuiltinManager.close).toHaveBeenCalledTimes(1);
    expect(secondBuiltinManager.close).toHaveBeenCalledTimes(1);
  });

  it("reports real qmd index counts for status-only requests", async () => {
    const agentId = "status-counts-agent";
    const cfg = createQmdCfg(agentId);
    mockPrimary.status.mockReturnValueOnce({
      ...createManagerStatus({
        backend: "qmd",
        model: "qmd",
        provider: "qmd",
        requestedProvider: "qmd",
        withMemorySourceCounts: true,
      }),
      chunks: 42,
      files: 10,
      sourceCounts: [{ chunks: 42, files: 10, source: "memory" as const }],
    });

    const result = await getMemorySearchManager({ agentId, cfg, purpose: "status" });
    const manager = requireManager(result);

    expect(manager.status()).toMatchObject({
      backend: "qmd",
      chunks: 42,
      files: 10,
      sourceCounts: [{ chunks: 42, files: 10, source: "memory" }],
    });
    expect(createQmdManagerMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId, mode: "status" }),
    );
  });

  it("reuses cached full qmd manager for status-only requests", async () => {
    const agentId = "status-reuses-full-agent";
    const cfg = createQmdCfg(agentId);

    const full = await getMemorySearchManager({ agentId, cfg });
    const status = await getMemorySearchManager({ agentId, cfg, purpose: "status" });

    requireManager(full);
    requireManager(status);
    expect(status.manager).not.toBe(full.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(1);
    await status.manager?.close?.();
    expect(mockPrimary.close).not.toHaveBeenCalled();

    const fullAgain = await getMemorySearchManager({ agentId, cfg });
    expect(fullAgain.manager).toBe(full.manager);
  });

  it("gets a fresh qmd manager for later status requests after close", async () => {
    const agentId = "status-eviction-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ agentId, cfg, purpose: "status" });
    const firstManager = requireManager(first);
    await firstManager.close?.();

    const second = await getMemorySearchManager({ agentId, cfg, purpose: "status" });
    requireManager(second);

    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
  });

  it("does not evict a newer cached wrapper when closing an older failed wrapper", async () => {
    const retryAgentId = "retry-agent-close";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await firstManager.search("hello");

    const second = await getMemorySearchManager({ agentId: retryAgentId, cfg });
    const secondManager = requireManager(second);
    expect(second.manager).not.toBe(first.manager);

    await firstManager.close?.();

    const third = await getMemorySearchManager({ agentId: retryAgentId, cfg });
    expect(third.manager).toBe(secondManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("falls back to builtin search when qmd fails with sqlite busy", async () => {
    const retryAgentId = "retry-agent-busy";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd index busy while reading results: SQLITE_BUSY: database is locked",
    });

    const results = await firstManager.search("hello");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("MEMORY.md");
    expect(fallbackSearch).toHaveBeenCalledTimes(1);
  });

  it("keeps original qmd error when fallback manager initialization fails", async () => {
    const retryAgentId = "retry-agent-no-fallback-auth";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    mockMemoryIndexGet.mockRejectedValueOnce(new Error("No API key found for provider openai"));

    await expect(firstManager.search("hello")).rejects.toThrow("qmd query failed");
  });

  it("closes cached managers on global teardown", async () => {
    const cfg = createQmdCfg("teardown-agent");
    const first = await getMemorySearchManager({ agentId: "teardown-agent", cfg });
    const firstManager = requireManager(first);

    await closeAllMemorySearchManagers();

    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);

    const second = await getMemorySearchManager({ agentId: "teardown-agent", cfg });
    expect(second.manager).toBeTruthy();
    expect(second.manager).not.toBe(firstManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("closes builtin index managers on teardown after runtime is loaded", async () => {
    const retryAgentId = "teardown-with-fallback";
    const { manager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await manager.search("hello");

    await closeAllMemorySearchManagers();

    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);
  });
});
