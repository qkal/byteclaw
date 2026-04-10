import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMemoryPluginState,
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryFlushPlanResolver,
  getMemoryPromptSectionBuilder,
  getMemoryRuntime,
  hasMemoryRuntime,
  listActiveMemoryPublicArtifacts,
  listMemoryCorpusSupplements,
  listMemoryPromptSupplements,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  registerMemoryPromptSupplement,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
  restoreMemoryPluginState,
} from "./memory-state.js";

function createMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { error: "missing", manager: null };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

function createMemoryFlushPlan(relativePath: string) {
  return {
    forceFlushTranscriptBytes: 2,
    prompt: relativePath,
    relativePath,
    reserveTokensFloor: 3,
    softThresholdTokens: 1,
    systemPrompt: relativePath,
  };
}

function expectClearedMemoryState() {
  expect(resolveMemoryFlushPlan({})).toBeNull();
  expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toEqual([]);
  expect(listMemoryCorpusSupplements()).toEqual([]);
  expect(getMemoryRuntime()).toBeUndefined();
}

function createMemoryStateSnapshot() {
  return {
    capability: getMemoryCapabilityRegistration(),
    corpusSupplements: listMemoryCorpusSupplements(),
    flushPlanResolver: getMemoryFlushPlanResolver(),
    promptBuilder: getMemoryPromptSectionBuilder(),
    promptSupplements: listMemoryPromptSupplements(),
    runtime: getMemoryRuntime(),
  };
}

function registerMemoryState(params: {
  promptSection?: string[];
  relativePath?: string;
  runtime?: ReturnType<typeof createMemoryRuntime>;
}) {
  if (params.promptSection) {
    registerMemoryPromptSection(() => params.promptSection ?? []);
  }
  if (params.relativePath) {
    const { relativePath } = params;
    registerMemoryFlushPlanResolver(() => createMemoryFlushPlan(relativePath));
  }
  if (params.runtime) {
    registerMemoryRuntime(params.runtime);
  }
}

describe("memory plugin state", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("returns empty defaults when no memory plugin state is registered", () => {
    expectClearedMemoryState();
  });

  it("delegates prompt building to the registered memory plugin", () => {
    registerMemoryPromptSection(({ availableTools }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return ["## Custom Memory", "Use custom memory tools.", ""];
    });

    expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toEqual([
      "## Custom Memory",
      "Use custom memory tools.",
      "",
    ]);
  });

  it("prefers the registered memory capability over legacy split state", async () => {
    const runtime = createMemoryRuntime();

    registerMemoryPromptSection(() => ["legacy prompt"]);
    registerMemoryFlushPlanResolver(() => createMemoryFlushPlan("memory/legacy.md"));
    registerMemoryRuntime({
      async getMemorySearchManager() {
        return { error: "legacy", manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    });
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => createMemoryFlushPlan("memory/capability.md"),
      promptBuilder: () => ["capability prompt"],
      runtime,
    });

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["capability prompt"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/capability.md");
    await expect(
      getMemoryRuntime()?.getMemorySearchManager({
        agentId: "main",
        cfg: {} as never,
      }),
    ).resolves.toEqual({ error: "missing", manager: null });
    expect(hasMemoryRuntime()).toBe(true);
    expect(getMemoryCapabilityRegistration()).toMatchObject({
      pluginId: "memory-core",
    });
  });

  it("lists active public memory artifacts in deterministic order", async () => {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              absolutePath: "/tmp/workspace-b/memory/2026-04-06.md",
              agentIds: ["beta"],
              contentType: "markdown" as const,
              kind: "daily-note",
              relativePath: "memory/2026-04-06.md",
              workspaceDir: "/tmp/workspace-b",
            },
            {
              absolutePath: "/tmp/workspace-a/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
              kind: "memory-root",
              relativePath: "MEMORY.md",
              workspaceDir: "/tmp/workspace-a",
            },
          ];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        absolutePath: "/tmp/workspace-a/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
        kind: "memory-root",
        relativePath: "MEMORY.md",
        workspaceDir: "/tmp/workspace-a",
      },
      {
        absolutePath: "/tmp/workspace-b/memory/2026-04-06.md",
        agentIds: ["beta"],
        contentType: "markdown",
        kind: "daily-note",
        relativePath: "memory/2026-04-06.md",
        workspaceDir: "/tmp/workspace-b",
      },
    ]);
  });

  it("passes citations mode through to the prompt builder", () => {
    registerMemoryPromptSection(({ citationsMode }) => [
      `citations: ${citationsMode ?? "default"}`,
    ]);

    expect(
      buildMemoryPromptSection({
        availableTools: new Set(),
        citationsMode: "off",
      }),
    ).toEqual(["citations: off"]);
  });

  it("appends prompt supplements in plugin-id order", () => {
    registerMemoryPromptSection(() => ["primary"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki"]);
    registerMemoryPromptSupplement("alpha-helper", () => ["alpha"]);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "primary",
      "alpha",
      "wiki",
    ]);
  });

  it("stores memory corpus supplements", async () => {
    const supplement = {
      get: async () => null,
      search: async () => [{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }],
    };

    registerMemoryCorpusSupplement("memory-wiki", supplement);

    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    await expect(
      listMemoryCorpusSupplements()[0]?.supplement.search({ query: "alpha" }),
    ).resolves.toEqual([{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }]);
  });

  it("uses the registered flush plan resolver", () => {
    registerMemoryFlushPlanResolver(() => ({
      forceFlushTranscriptBytes: 2,
      prompt: "prompt",
      relativePath: "memory/test.md",
      reserveTokensFloor: 3,
      softThresholdTokens: 1,
      systemPrompt: "system",
    }));

    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/test.md");
  });

  it("stores the registered memory runtime", async () => {
    const runtime = createMemoryRuntime();

    registerMemoryRuntime(runtime);

    expect(getMemoryRuntime()).toBe(runtime);
    await expect(
      getMemoryRuntime()?.getMemorySearchManager({
        agentId: "main",
        cfg: {} as never,
      }),
    ).resolves.toEqual({ error: "missing", manager: null });
  });

  it("restoreMemoryPluginState swaps both prompt and flush state", () => {
    const runtime = createMemoryRuntime();
    registerMemoryState({
      promptSection: ["first"],
      relativePath: "memory/first.md",
      runtime,
    });
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki supplement"]);
    registerMemoryCorpusSupplement("memory-wiki", {
      get: async () => null,
      search: async () => [{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }],
    });
    const snapshot = createMemoryStateSnapshot();

    _resetMemoryPluginState();
    expectClearedMemoryState();

    restoreMemoryPluginState(snapshot);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "first",
      "wiki supplement",
    ]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(getMemoryRuntime()).toBe(runtime);
  });

  it("clearMemoryPluginState resets both registries", () => {
    registerMemoryState({
      promptSection: ["stale section"],
      relativePath: "memory/stale.md",
      runtime: createMemoryRuntime(),
    });

    clearMemoryPluginState();

    expectClearedMemoryState();
  });
});
