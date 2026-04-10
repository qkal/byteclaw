import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type MemoryEmbeddingProviderAdapter,
  clearMemoryEmbeddingProviders,
  getMemoryEmbeddingProvider,
  getRegisteredMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
  restoreMemoryEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
} from "./memory-embedding-providers.js";

const MEMORY_EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviders");
const INITIAL_REGISTERED_MEMORY_EMBEDDING_PROVIDERS = listRegisteredMemoryEmbeddingProviders();

function createAdapter(id: string): MemoryEmbeddingProviderAdapter {
  return {
    create: async () => ({ provider: null }),
    id,
  };
}

function expectRegisteredProviderEntry(
  id: string,
  entry: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  },
) {
  expect(getRegisteredMemoryEmbeddingProvider(id)).toEqual(entry);
}

function createOwnedAdapterEntry(id: string) {
  return {
    adapter: createAdapter(id),
    ownerPluginId: "memory-core",
  };
}

function expectRegisteredProviderState(params: {
  entry: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  };
  expectedList?: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  }[];
}) {
  expectRegisteredProviderEntry(params.entry.adapter.id, params.entry);
  if (params.expectedList) {
    expect(listRegisteredMemoryEmbeddingProviders()).toEqual(params.expectedList);
  }
}

function expectMemoryEmbeddingProviderIds(expectedIds: readonly string[]) {
  expect(listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([...expectedIds]);
}

function expectCurrentMemoryEmbeddingProvider(
  id: string,
  adapter: MemoryEmbeddingProviderAdapter | undefined,
) {
  expect(getMemoryEmbeddingProvider(id)).toBe(adapter);
}

function expectMemoryEmbeddingProviderState(params: {
  expectedIds: readonly string[];
  expectedCurrent?: { id: string; adapter: MemoryEmbeddingProviderAdapter };
}) {
  if (params.expectedCurrent) {
    expectCurrentMemoryEmbeddingProvider(params.expectedCurrent.id, params.expectedCurrent.adapter);
  }
  expectMemoryEmbeddingProviderIds(params.expectedIds);
}

function expectRegisteredProviderSnapshotCase(params: {
  entry: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  };
  setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) => void;
  expectedList?: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  }[];
}) {
  params.setup(params.entry);
  expectRegisteredProviderState({
    entry: params.entry,
    ...(params.expectedList ? { expectedList: params.expectedList } : {}),
  });
}

beforeEach(() => {
  clearMemoryEmbeddingProviders();
});

afterEach(() => {
  restoreRegisteredMemoryEmbeddingProviders(INITIAL_REGISTERED_MEMORY_EMBEDDING_PROVIDERS);
});

describe("memory embedding provider registry", () => {
  it("registers and lists adapters in insertion order", () => {
    const alpha = createAdapter("alpha");
    const beta = createAdapter("beta");
    registerMemoryEmbeddingProvider(alpha);
    registerMemoryEmbeddingProvider(beta);

    expectMemoryEmbeddingProviderState({
      expectedCurrent: { adapter: alpha, id: "alpha" },
      expectedIds: ["alpha", "beta"],
    });
  });

  it("restores a previous snapshot", () => {
    const alpha = createAdapter("alpha");
    const beta = createAdapter("beta");
    registerMemoryEmbeddingProvider(alpha);

    restoreMemoryEmbeddingProviders([beta]);

    expectCurrentMemoryEmbeddingProvider("alpha", undefined);
    expectCurrentMemoryEmbeddingProvider("beta", beta);
  });

  it.each([
    {
      entry: createOwnedAdapterEntry("alpha"),
      expectList: true,
      name: "tracks owner plugin ids in registered snapshots",
      setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) =>
        registerMemoryEmbeddingProvider(entry.adapter, { ownerPluginId: entry.ownerPluginId }),
    },
    {
      entry: createOwnedAdapterEntry("beta"),
      expectList: false,
      name: "restores registered snapshots with owner metadata",
      setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) =>
        restoreRegisteredMemoryEmbeddingProviders([entry]),
    },
  ] as const)("$name", ({ entry, setup, expectList }) => {
    expectRegisteredProviderSnapshotCase({
      entry,
      setup,
      ...(expectList ? { expectedList: [entry] } : {}),
    });
  });

  it("clears the registry", () => {
    registerMemoryEmbeddingProvider(createAdapter("alpha"));

    clearMemoryEmbeddingProviders();

    expectMemoryEmbeddingProviderIds([]);
  });

  it("stores adapters in a process-global singleton map", () => {
    const alpha = createAdapter("alpha");
    registerMemoryEmbeddingProvider(alpha, { ownerPluginId: "memory-core" });

    const globalRegistry = (globalThis as Record<PropertyKey, unknown>)[
      MEMORY_EMBEDDING_PROVIDERS_KEY
    ] as Map<string, { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }>;

    expect(globalRegistry.get("alpha")).toEqual({
      adapter: alpha,
      ownerPluginId: "memory-core",
    });
  });
});
