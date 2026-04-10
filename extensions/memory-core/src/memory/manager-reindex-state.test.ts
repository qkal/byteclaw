import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import {
  type MemoryIndexMeta,
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  shouldRunFullMemoryReindex,
} from "./manager-reindex-state.js";

function createMeta(overrides: Partial<MemoryIndexMeta> = {}): MemoryIndexMeta {
  return {
    chunkOverlap: 0,
    chunkTokens: 4000,
    ftsTokenizer: "unicode61",
    model: "mock-embed-v1",
    provider: "openai",
    providerKey: "provider-key-v1",
    scopeHash: "scope-v1",
    sources: ["memory"],
    ...overrides,
  };
}

function createFullReindexParams(
  overrides: {
    meta?: MemoryIndexMeta | null;
    provider?: { id: string; model: string } | null;
    providerKey?: string;
    configuredSources?: MemorySource[];
    configuredScopeHash?: string;
    chunkTokens?: number;
    chunkOverlap?: number;
    vectorReady?: boolean;
    ftsTokenizer?: string;
  } = {},
) {
  return {
    chunkOverlap: 0,
    chunkTokens: 4000,
    configuredScopeHash: "scope-v1",
    configuredSources: ["memory"] as MemorySource[],
    ftsTokenizer: "unicode61",
    meta: createMeta(),
    provider: { id: "openai", model: "mock-embed-v1" },
    providerKey: "provider-key-v1",
    vectorReady: false,
    ...overrides,
  };
}

describe("memory reindex state", () => {
  it("requires a full reindex when the embedding model changes", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          provider: { id: "openai", model: "mock-embed-v2" },
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when the provider cache key changes", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: createMeta({
            model: "gemini-embedding-2-preview",
            provider: "gemini",
            providerKey: "provider-key-dims-3072",
          }),
          provider: { id: "gemini", model: "gemini-embedding-2-preview" },
          providerKey: "provider-key-dims-768",
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when extraPaths change", () => {
    const workspaceDir = "/tmp/workspace";
    const firstScopeHash = resolveConfiguredScopeHash({
      extraPaths: ["/tmp/workspace/a"],
      multimodal: {
        enabled: false,
        maxFileBytes: 20 * 1024 * 1024,
        modalities: [],
      },
      workspaceDir,
    });
    const secondScopeHash = resolveConfiguredScopeHash({
      extraPaths: ["/tmp/workspace/b"],
      multimodal: {
        enabled: false,
        maxFileBytes: 20 * 1024 * 1024,
        modalities: [],
      },
      workspaceDir,
    });

    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          configuredScopeHash: secondScopeHash,
          meta: createMeta({ scopeHash: firstScopeHash }),
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when configured sources add sessions", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          configuredSources: ["memory", "sessions"],
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when multimodal settings change", () => {
    const workspaceDir = "/tmp/workspace";
    const firstScopeHash = resolveConfiguredScopeHash({
      extraPaths: ["/tmp/workspace/media"],
      multimodal: {
        enabled: false,
        maxFileBytes: 20 * 1024 * 1024,
        modalities: [],
      },
      workspaceDir,
    });
    const secondScopeHash = resolveConfiguredScopeHash({
      extraPaths: ["/tmp/workspace/media"],
      multimodal: {
        enabled: true,
        maxFileBytes: 20 * 1024 * 1024,
        modalities: ["image"],
      },
      workspaceDir,
    });

    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          configuredScopeHash: secondScopeHash,
          meta: createMeta({ scopeHash: firstScopeHash }),
        }),
      ),
    ).toBe(true);
  });

  it("keeps older indexes with missing sources compatible with memory-only config", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          configuredSources: resolveConfiguredSourcesForMeta(new Set(["memory"])),
          meta: createMeta({ sources: undefined }),
        }),
      ),
    ).toBe(false);
  });
});
