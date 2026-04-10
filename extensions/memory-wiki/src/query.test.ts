import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { getActiveMemorySearchManagerMock, resolveDefaultAgentIdMock, resolveSessionAgentIdMock } =
  vi.hoisted(() => ({
    getActiveMemorySearchManagerMock: vi.fn(),
    resolveDefaultAgentIdMock: vi.fn(() => "main"),
    resolveSessionAgentIdMock: vi.fn(({ sessionKey }: { sessionKey?: string }) =>
      sessionKey === "agent:secondary:thread" ? "secondary" : "main",
    ),
  }));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: getActiveMemorySearchManagerMock,
}));

vi.mock("openclaw/plugin-sdk/memory-host-core", () => ({
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;

beforeEach(() => {
  getActiveMemorySearchManagerMock.mockReset();
  getActiveMemorySearchManagerMock.mockResolvedValue({ error: "unavailable", manager: null });
  resolveDefaultAgentIdMock.mockClear();
  resolveSessionAgentIdMock.mockClear();
});

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-query-suite-"));
});

afterAll(async () => {
  if (suiteRoot) {
    await fs.rm(suiteRoot, { force: true, recursive: true });
  }
});

async function createQueryVault(options?: {
  config?: MemoryWikiPluginConfig;
  initialize?: boolean;
}) {
  return createVault({
    config: options?.config,
    initialize: options?.initialize,
    prefix: "memory-wiki-query-",
    rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
  });
}

function createAppConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ default: true, id: "main" }],
    },
  } as OpenClawConfig;
}

function createMemoryManager(overrides?: {
  searchResults?: {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: "memory" | "sessions";
    citation?: string;
  }[];
  readResult?: { text: string; path: string };
}) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
    probeVectorAvailability: vi.fn().mockResolvedValue(false),
    readFile: vi.fn().mockImplementation(async () => {
      if (!overrides?.readResult) {
        throw new Error("missing");
      }
      return overrides.readResult;
    }),
    search: vi.fn().mockResolvedValue(overrides?.searchResults ?? []),
    status: vi.fn().mockReturnValue({ backend: "builtin", provider: "builtin" }),
  };
}

describe("searchMemoryWiki", () => {
  it("finds wiki pages by title and body", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha Source\n\nalpha body text\n",
        frontmatter: { id: "source.alpha", pageType: "source", title: "Alpha Source" },
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "alpha" });

    expect(results).toHaveLength(1);
    expect(results[0]?.corpus).toBe("wiki");
    expect(results[0]?.path).toBe("sources/alpha.md");
    expect(getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("finds wiki pages by structured claim text and surfaces the claim as the snippet", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha\n\nsummary without the query phrase\n",
        frontmatter: {
          claims: [
            {
              confidence: 0.91,
              evidence: [{ sourceId: "source.alpha", lines: "12-18" }],
              id: "claim.alpha.postgres",
              status: "supported",
              text: "Alpha uses PostgreSQL for production writes.",
            },
          ],
          id: "entity.alpha",
          pageType: "entity",
          title: "Alpha",
        },
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "postgresql" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      corpus: "wiki",
      path: "entities/alpha.md",
      snippet: "Alpha uses PostgreSQL for production writes.",
    });
  });

  it("ranks fresh supported claims ahead of stale contested claims", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha-fresh.md"),
      renderWikiMarkdown({
        body: "# Alpha Fresh\n\nsummary without the keyword\n",
        frontmatter: {
          claims: [
            {
              confidence: 0.91,
              evidence: [
                {
                  sourceId: "source.alpha",
                  lines: "4-7",
                  updatedAt: "2026-04-01T00:00:00.000Z",
                },
              ],
              id: "claim.alpha.db.fresh",
              status: "supported",
              text: "Alpha uses PostgreSQL for production writes.",
            },
          ],
          id: "entity.alpha.fresh",
          pageType: "entity",
          title: "Alpha Fresh",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha-stale.md"),
      renderWikiMarkdown({
        body: "# Alpha Stale\n\nsummary without the keyword\n",
        frontmatter: {
          claims: [
            {
              confidence: 0.92,
              evidence: [
                {
                  sourceId: "source.alpha.old",
                  lines: "1-2",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
              id: "claim.alpha.db.stale",
              status: "contested",
              text: "Alpha uses PostgreSQL for production writes.",
            },
          ],
          id: "entity.alpha.stale",
          pageType: "entity",
          title: "Alpha Stale",
          updatedAt: "2025-10-01T00:00:00.000Z",
        },
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "postgresql" });

    expect(results).toHaveLength(2);
    expect(results[0]?.path).toBe("entities/alpha-fresh.md");
    expect(results[1]?.path).toBe("entities/alpha-stale.md");
  });

  it("surfaces bridge provenance for imported source pages", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        body: "# Bridge Alpha\n\nalpha bridge body\n",
        frontmatter: {
          bridgeRelativePath: "MEMORY.md",
          bridgeWorkspaceDir: "/tmp/workspace",
          id: "source.bridge.alpha",
          pageType: "source",
          sourcePath: "/tmp/workspace/MEMORY.md",
          sourceType: "memory-bridge",
          title: "Bridge Alpha",
          updatedAt: "2026-04-05T12:00:00.000Z",
        },
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "alpha" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      corpus: "wiki",
      provenanceLabel: "bridge: MEMORY.md",
      sourcePath: "/tmp/workspace/MEMORY.md",
      sourceType: "memory-bridge",
      updatedAt: "2026-04-05T12:00:00.000Z",
    });
  });

  it("includes active memory results when shared search and all corpora are enabled", async () => {
    const { rootDir, config } = await createQueryVault({
      config: {
        search: { backend: "shared", corpus: "all" },
      },
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha Source\n\nalpha body text\n",
        frontmatter: { id: "source.alpha", pageType: "source", title: "Alpha Source" },
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      searchResults: [
        {
          citation: "MEMORY.md#L4-L8",
          endLine: 8,
          path: "MEMORY.md",
          score: 42,
          snippet: "alpha durable memory",
          source: "memory",
          startLine: 4,
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const results = await searchMemoryWiki({
      appConfig: createAppConfig(),
      config,
      maxResults: 5,
      query: "alpha",
    });

    expect(results).toHaveLength(2);
    expect(results.some((result) => result.corpus === "wiki")).toBe(true);
    expect(results.some((result) => result.corpus === "memory")).toBe(true);
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 5 });
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      agentId: "main",
      cfg: createAppConfig(),
    });
  });

  it("uses the active session agent for shared memory search", async () => {
    const { config } = await createQueryVault({
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
      initialize: true,
    });
    const manager = createMemoryManager({
      searchResults: [
        {
          endLine: 2,
          path: "memory/2026-04-07.md",
          score: 1,
          snippet: "secondary agent memory",
          source: "memory",
          startLine: 1,
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    await searchMemoryWiki({
      agentSessionKey: "agent:secondary:thread",
      appConfig: createAppConfig(),
      config,
      query: "secondary",
    });

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      config: createAppConfig(),
      sessionKey: "agent:secondary:thread",
    });
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      agentId: "secondary",
      cfg: createAppConfig(),
    });
  });

  it("allows per-call corpus overrides without changing config defaults", async () => {
    const { rootDir, config } = await createQueryVault({
      config: {
        search: { backend: "shared", corpus: "wiki" },
      },
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha Source\n\nalpha body text\n",
        frontmatter: { id: "source.alpha", pageType: "source", title: "Alpha Source" },
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      searchResults: [
        {
          endLine: 12,
          path: "MEMORY.md",
          score: 99,
          snippet: "memory-only alpha",
          source: "memory",
          startLine: 10,
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const memoryOnly = await searchMemoryWiki({
      appConfig: createAppConfig(),
      config,
      query: "alpha",
      searchCorpus: "memory",
    });

    expect(memoryOnly).toHaveLength(1);
    expect(memoryOnly[0]?.corpus).toBe("memory");
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 10 });
  });

  it("keeps memory search disabled when the backend is local", async () => {
    const { rootDir, config } = await createQueryVault({
      config: {
        search: { backend: "local", corpus: "all" },
      },
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha Source\n\nalpha only wiki\n",
        frontmatter: { id: "source.alpha", pageType: "source", title: "Alpha Source" },
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      searchResults: [
        {
          endLine: 2,
          path: "MEMORY.md",
          score: 50,
          snippet: "alpha memory",
          source: "memory",
          startLine: 1,
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const results = await searchMemoryWiki({
      appConfig: createAppConfig(),
      config,
      query: "alpha",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.corpus).toBe("wiki");
    expect(manager.search).not.toHaveBeenCalled();
  });
});

describe("getMemoryWikiPage", () => {
  it("reads wiki pages by relative path and slices line ranges", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha Source\n\nline one\nline two\nline three\n",
        frontmatter: { id: "source.alpha", pageType: "source", title: "Alpha Source" },
      }),
      "utf8",
    );

    const result = await getMemoryWikiPage({
      config,
      fromLine: 4,
      lineCount: 2,
      lookup: "sources/alpha.md",
    });

    expect(result?.corpus).toBe("wiki");
    expect(result?.path).toBe("sources/alpha.md");
    expect(result?.content).toContain("line one");
    expect(result?.content).toContain("line two");
    expect(result?.content).not.toContain("line three");
  });

  it("resolves compiled claim ids back to the owning page", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha\n\nline one\nline two\n",
        frontmatter: {
          claims: [
            {
              evidence: [{ sourceId: "source.alpha", lines: "1-2" }],
              id: "claim.alpha.db",
              status: "supported",
              text: "Alpha uses PostgreSQL for production writes.",
            },
          ],
          id: "entity.alpha",
          pageType: "entity",
          title: "Alpha",
        },
      }),
      "utf8",
    );
    await compileMemoryWikiVault(config);

    const result = await getMemoryWikiPage({
      config,
      lookup: "claim.alpha.db",
    });

    expect(result).toMatchObject({
      corpus: "wiki",
      id: "entity.alpha",
      path: "entities/alpha.md",
      title: "Alpha",
    });
    expect(result?.content).toContain("line one");
  });

  it("returns provenance for imported wiki source pages", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe-alpha.md"),
      renderWikiMarkdown({
        body: "# Unsafe Alpha\n\nsecret alpha\n",
        frontmatter: {
          id: "source.unsafe.alpha",
          pageType: "source",
          provenanceMode: "unsafe-local",
          sourcePath: "/tmp/private/alpha.md",
          sourceType: "memory-unsafe-local",
          title: "Unsafe Alpha",
          unsafeLocalConfiguredPath: "/tmp/private",
          unsafeLocalRelativePath: "alpha.md",
          updatedAt: "2026-04-05T13:00:00.000Z",
        },
      }),
      "utf8",
    );

    const result = await getMemoryWikiPage({
      config,
      lookup: "sources/unsafe-alpha.md",
    });

    expect(result).toMatchObject({
      corpus: "wiki",
      path: "sources/unsafe-alpha.md",
      provenanceLabel: "unsafe-local: alpha.md",
      provenanceMode: "unsafe-local",
      sourcePath: "/tmp/private/alpha.md",
      sourceType: "memory-unsafe-local",
      updatedAt: "2026-04-05T13:00:00.000Z",
    });
  });

  it("falls back to active memory reads when memory corpus is selected", async () => {
    const { config } = await createQueryVault({
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
      initialize: true,
    });
    const manager = createMemoryManager({
      readResult: {
        path: "MEMORY.md",
        text: "durable alpha memory\nline two",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      appConfig: createAppConfig(),
      config,
      fromLine: 2,
      lineCount: 2,
      lookup: "MEMORY.md",
    });

    expect(result).toEqual({
      content: "durable alpha memory\nline two",
      corpus: "memory",
      fromLine: 2,
      kind: "memory",
      lineCount: 2,
      path: "MEMORY.md",
      title: "MEMORY",
    });
    expect(manager.readFile).toHaveBeenCalledWith({
      from: 2,
      lines: 2,
      relPath: "MEMORY.md",
    });
  });

  it("uses the active session agent for shared memory reads", async () => {
    const { config } = await createQueryVault({
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
      initialize: true,
    });
    const manager = createMemoryManager({
      readResult: {
        path: "MEMORY.md",
        text: "secondary memory line",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      agentSessionKey: "agent:secondary:thread",
      appConfig: createAppConfig(),
      config,
      lookup: "MEMORY.md",
    });

    expect(result?.corpus).toBe("memory");
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      config: createAppConfig(),
      sessionKey: "agent:secondary:thread",
    });
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      agentId: "secondary",
      cfg: createAppConfig(),
    });
  });

  it("allows per-call get overrides to bypass wiki and force memory fallback", async () => {
    const { rootDir, config } = await createQueryVault({
      config: {
        search: { backend: "shared", corpus: "wiki" },
      },
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "MEMORY.md"),
      renderWikiMarkdown({
        body: "# Shadow Memory\n\nwiki copy\n",
        frontmatter: { id: "source.memory.shadow", pageType: "source", title: "Shadow Memory" },
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      readResult: {
        path: "MEMORY.md",
        text: "forced memory read",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      appConfig: createAppConfig(),
      config,
      lookup: "MEMORY.md",
      searchCorpus: "memory",
    });

    expect(result?.corpus).toBe("memory");
    expect(result?.content).toBe("forced memory read");
    expect(manager.readFile).toHaveBeenCalled();
  });
});
