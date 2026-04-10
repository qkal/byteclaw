import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMemorySearchManager: vi.fn(),
  resolveMemorySearchConfig: vi.fn(),
  resolveSharedMemoryStatusSnapshot: vi.fn(),
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: mocks.resolveMemorySearchConfig,
}));

vi.mock("./status.scan.deps.runtime.js", () => ({
  getMemorySearchManager: mocks.getMemorySearchManager,
}));

vi.mock("./status.scan.shared.js", () => ({
  resolveSharedMemoryStatusSnapshot: mocks.resolveSharedMemoryStatusSnapshot,
}));

describe("status.scan-memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSharedMemoryStatusSnapshot.mockResolvedValue({ agentId: "main" });
  });

  it("forwards the shared memory snapshot dependencies", async () => {
    const { resolveStatusMemoryStatusSnapshot } = await import("./status.scan-memory.ts");

    const requireDefaultStore = vi.fn((agentId: string) => `/tmp/${agentId}.sqlite`);
    await resolveStatusMemoryStatusSnapshot({
      agentStatus: {
        agents: [
          {
            bootstrapPending: false,
            id: "main",
            lastActiveAgeMs: null,
            lastUpdatedAt: null,
            sessionsCount: 0,
            sessionsPath: "/tmp/main.json",
            workspaceDir: null,
          },
        ],
        bootstrapPendingCount: 0,
        defaultId: "main",
        totalSessions: 0,
      },
      cfg: { agents: {} },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      requireDefaultStore,
    });

    expect(mocks.resolveSharedMemoryStatusSnapshot).toHaveBeenCalledWith({
      agentStatus: {
        agents: [
          {
            bootstrapPending: false,
            id: "main",
            lastActiveAgeMs: null,
            lastUpdatedAt: null,
            sessionsCount: 0,
            sessionsPath: "/tmp/main.json",
            workspaceDir: null,
          },
        ],
        bootstrapPendingCount: 0,
        defaultId: "main",
        totalSessions: 0,
      },
      cfg: { agents: {} },
      getMemorySearchManager: mocks.getMemorySearchManager,
      memoryPlugin: { enabled: true, slot: "memory-core" },
      requireDefaultStore,
      resolveMemoryConfig: mocks.resolveMemorySearchConfig,
    });
  });
});
