import { beforeEach, describe, expect, it, vi } from "vitest";

const rewriteTranscriptEntriesInSessionManagerMock = vi.fn((_params?: unknown) => ({
  bytesFreed: 77,
  changed: true,
  rewrittenEntries: 1,
}));
const rewriteTranscriptEntriesInSessionFileMock = vi.fn(async (_params?: unknown) => ({
  bytesFreed: 123,
  changed: true,
  rewrittenEntries: 2,
}));
let buildContextEngineMaintenanceRuntimeContext: typeof import("./context-engine-maintenance.js").buildContextEngineMaintenanceRuntimeContext;
let runContextEngineMaintenance: typeof import("./context-engine-maintenance.js").runContextEngineMaintenance;

vi.mock("./transcript-rewrite.js", () => ({
  rewriteTranscriptEntriesInSessionFile: (params: unknown) =>
    rewriteTranscriptEntriesInSessionFileMock(params),
  rewriteTranscriptEntriesInSessionManager: (params: unknown) =>
    rewriteTranscriptEntriesInSessionManagerMock(params),
}));

async function loadFreshContextEngineMaintenanceModuleForTest() {
  vi.resetModules();
  ({ buildContextEngineMaintenanceRuntimeContext, runContextEngineMaintenance } =
    await import("./context-engine-maintenance.js"));
}

describe("buildContextEngineMaintenanceRuntimeContext", () => {
  beforeEach(async () => {
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    rewriteTranscriptEntriesInSessionFileMock.mockClear();
    await loadFreshContextEngineMaintenanceModuleForTest();
  });

  it("adds a transcript rewrite helper that targets the current session file", async () => {
    const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
      runtimeContext: { workspaceDir: "/tmp/workspace" },
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });

    expect(runtimeContext.workspaceDir).toBe("/tmp/workspace");
    expect(typeof runtimeContext.rewriteTranscriptEntries).toBe("function");

    const result = await runtimeContext.rewriteTranscriptEntries?.({
      replacements: [
        { entryId: "entry-1", message: { content: "hi", role: "user", timestamp: 1 } },
      ],
    });

    expect(result).toEqual({
      bytesFreed: 123,
      changed: true,
      rewrittenEntries: 2,
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).toHaveBeenCalledWith({
      request: {
        replacements: [
          { entryId: "entry-1", message: { content: "hi", role: "user", timestamp: 1 } },
        ],
      },
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
  });

  it("reuses the active session manager when one is provided", async () => {
    const sessionManager = { appendMessage: vi.fn() } as unknown as Parameters<
      typeof buildContextEngineMaintenanceRuntimeContext
    >[0]["sessionManager"];
    const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionManager,
    });

    const result = await runtimeContext.rewriteTranscriptEntries?.({
      replacements: [
        { entryId: "entry-1", message: { content: "hi", role: "user", timestamp: 1 } },
      ],
    });

    expect(result).toEqual({
      bytesFreed: 77,
      changed: true,
      rewrittenEntries: 1,
    });
    expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
      replacements: [
        { entryId: "entry-1", message: { content: "hi", role: "user", timestamp: 1 } },
      ],
      sessionManager,
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();
  });
});

describe("runContextEngineMaintenance", () => {
  beforeEach(async () => {
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    rewriteTranscriptEntriesInSessionFileMock.mockClear();
    await loadFreshContextEngineMaintenanceModuleForTest();
  });

  it("passes a rewrite-capable runtime context into maintain()", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      bytesFreed: 0,
      changed: false,
      rewrittenEntries: 0,
    }));

    const result = await runContextEngineMaintenance({
      contextEngine: {
        assemble: async ({ messages }) => ({ estimatedTokens: 0, messages }),
        compact: async () => ({ compacted: false, ok: true }),
        info: { id: "test", name: "Test Engine" },
        ingest: async () => ({ ingested: true }),
        maintain,
      },
      reason: "turn",
      runtimeContext: { workspaceDir: "/tmp/workspace" },
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });

    expect(result).toEqual({
      bytesFreed: 0,
      changed: false,
      rewrittenEntries: 0,
    });
    expect(maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          workspaceDir: "/tmp/workspace",
        }),
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
    );
    const runtimeContext = (
      maintain.mock.calls[0]?.[0] as
        | { runtimeContext?: { rewriteTranscriptEntries?: (request: unknown) => Promise<unknown> } }
        | undefined
    )?.runtimeContext as
      | { rewriteTranscriptEntries?: (request: unknown) => Promise<unknown> }
      | undefined;
    expect(typeof runtimeContext?.rewriteTranscriptEntries).toBe("function");
  });
});
