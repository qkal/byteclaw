import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const readAcpSessionEntryMock = vi.fn();
const resolveSessionFilePathMock = vi.fn();
const resolveSessionFilePathOptionsMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock(
  "../infra/heartbeat-wake.js",
  async () =>
    await mergeMockedModule(
      await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
        "../infra/heartbeat-wake.js",
      ),
      () => ({
        requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
      }),
    ),
);

vi.mock(
  "../acp/runtime/session-meta.js",
  async () =>
    await mergeMockedModule(
      await vi.importActual<typeof import("../acp/runtime/session-meta.js")>(
        "../acp/runtime/session-meta.js",
      ),
      () => ({
        readAcpSessionEntry: (...args: unknown[]) => readAcpSessionEntryMock(...args),
      }),
    ),
);

vi.mock(
  "../config/sessions/paths.js",
  async () =>
    await mergeMockedModule(
      await vi.importActual<typeof import("../config/sessions/paths.js")>(
        "../config/sessions/paths.js",
      ),
      () => ({
        resolveSessionFilePath: (...args: unknown[]) => resolveSessionFilePathMock(...args),
        resolveSessionFilePathOptions: (...args: unknown[]) =>
          resolveSessionFilePathOptionsMock(...args),
      }),
    ),
);

let emitAgentEvent: typeof import("../infra/agent-events.js").emitAgentEvent;
let resolveAcpSpawnStreamLogPath: typeof import("./acp-spawn-parent-stream.js").resolveAcpSpawnStreamLogPath;
let startAcpSpawnParentStreamRelay: typeof import("./acp-spawn-parent-stream.js").startAcpSpawnParentStreamRelay;

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../infra/agent-events.js"));
    ({ resolveAcpSpawnStreamLogPath, startAcpSpawnParentStreamRelay } =
      await import("./acp-spawn-parent-stream.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    readAcpSessionEntryMock.mockReset();
    resolveSessionFilePathMock.mockReset();
    resolveSessionFilePathOptionsMock.mockReset();
    resolveSessionFilePathOptionsMock.mockImplementation((value: unknown) => value);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays assistant progress and completion to the parent session", () => {
    const deliveryContext = {
      accountId: "default",
      channel: "telegram",
      threadId: 1122,
      to: "-1001234567890",
    };
    const relay = startAcpSpawnParentStreamRelay({
      agentId: "codex",
      childSessionKey: "agent:codex:acp:child-1",
      deliveryContext,
      noOutputNoticeMs: 120_000,
      parentSessionKey: "agent:main:main",
      runId: "run-1",
      streamFlushMs: 10,
    });

    emitAgentEvent({
      data: {
        delta: "hello from child",
      },
      runId: "run-1",
      stream: "assistant",
    });
    vi.advanceTimersByTime(15);

    emitAgentEvent({
      data: {
        endedAt: 3100,
        phase: "end",
        startedAt: 1000,
      },
      runId: "run-1",
      stream: "lifecycle",
    });

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("Started codex session"))).toBe(true);
    expect(texts.some((text) => text.includes("codex: hello from child"))).toBe(true);
    expect(texts.some((text) => text.includes("codex run completed in 2s"))).toBe(true);
    expect(
      enqueueSystemEventMock.mock.calls.every(
        (call) => (call[1] as { trusted?: boolean } | undefined)?.trusted === false,
      ),
    ).toBe(true);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        deliveryContext,
        sessionKey: "agent:main:main",
        trusted: false,
      }),
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      }),
    );
    relay.dispose();
  });

  it("emits a no-output notice and a resumed notice when output returns", () => {
    const relay = startAcpSpawnParentStreamRelay({
      agentId: "codex",
      childSessionKey: "agent:codex:acp:child-2",
      noOutputNoticeMs: 1000,
      noOutputPollMs: 250,
      parentSessionKey: "agent:main:main",
      runId: "run-2",
      streamFlushMs: 1,
    });

    vi.advanceTimersByTime(1500);
    expect(collectedTexts().some((text) => text.includes("has produced no output for 1s"))).toBe(
      true,
    );

    emitAgentEvent({
      data: {
        delta: "resumed output",
      },
      runId: "run-2",
      stream: "assistant",
    });
    vi.advanceTimersByTime(5);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("resumed output."))).toBe(true);
    expect(texts.some((text) => text.includes("codex: resumed output"))).toBe(true);

    emitAgentEvent({
      data: {
        error: "boom",
        phase: "error",
      },
      runId: "run-2",
      stream: "lifecycle",
    });
    expect(collectedTexts().some((text) => text.includes("run failed: boom"))).toBe(true);
    relay.dispose();
  });

  it("auto-disposes stale relays after max lifetime timeout", () => {
    const relay = startAcpSpawnParentStreamRelay({
      agentId: "codex",
      childSessionKey: "agent:codex:acp:child-3",
      maxRelayLifetimeMs: 1000,
      noOutputNoticeMs: 0,
      parentSessionKey: "agent:main:main",
      runId: "run-3",
      streamFlushMs: 1,
    });

    vi.advanceTimersByTime(1001);
    expect(collectedTexts().some((text) => text.includes("stream relay timed out after 1s"))).toBe(
      true,
    );

    const before = enqueueSystemEventMock.mock.calls.length;
    emitAgentEvent({
      data: {
        delta: "late output",
      },
      runId: "run-3",
      stream: "assistant",
    });
    vi.advanceTimersByTime(5);

    expect(enqueueSystemEventMock.mock.calls).toHaveLength(before);
    relay.dispose();
  });

  it("supports delayed start notices", () => {
    const relay = startAcpSpawnParentStreamRelay({
      agentId: "codex",
      childSessionKey: "agent:codex:acp:child-4",
      emitStartNotice: false,
      parentSessionKey: "agent:main:main",
      runId: "run-4",
    });

    expect(collectedTexts().some((text) => text.includes("Started codex session"))).toBe(false);

    relay.notifyStarted();

    expect(collectedTexts().some((text) => text.includes("Started codex session"))).toBe(true);
    relay.dispose();
  });

  it("can keep background relays out of the parent session while still logging", () => {
    const relay = startAcpSpawnParentStreamRelay({
      agentId: "codex",
      childSessionKey: "agent:codex:acp:child-quiet",
      noOutputNoticeMs: 120_000,
      parentSessionKey: "agent:main:main",
      runId: "run-quiet",
      streamFlushMs: 10,
      surfaceUpdates: false,
    });

    relay.notifyStarted();
    emitAgentEvent({
      data: {
        delta: "hello from child",
      },
      runId: "run-quiet",
      stream: "assistant",
    });
    vi.advanceTimersByTime(15);
    emitAgentEvent({
      data: {
        phase: "end",
      },
      runId: "run-quiet",
      stream: "lifecycle",
    });

    expect(collectedTexts()).toEqual([]);
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("preserves delta whitespace boundaries in progress relays", () => {
    const relay = startAcpSpawnParentStreamRelay({
      agentId: "codex",
      childSessionKey: "agent:codex:acp:child-5",
      noOutputNoticeMs: 120_000,
      parentSessionKey: "agent:main:main",
      runId: "run-5",
      streamFlushMs: 10,
    });

    emitAgentEvent({
      data: {
        delta: "hello",
      },
      runId: "run-5",
      stream: "assistant",
    });
    emitAgentEvent({
      data: {
        delta: " world",
      },
      runId: "run-5",
      stream: "assistant",
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("codex: hello world"))).toBe(true);
    relay.dispose();
  });

  it("resolves ACP spawn stream log path from session metadata", () => {
    readAcpSessionEntryMock.mockReturnValue({
      entry: {
        sessionFile: "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
        sessionId: "sess-123",
      },
      storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
    });
    resolveSessionFilePathMock.mockReturnValue(
      "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
    );

    const resolved = resolveAcpSpawnStreamLogPath({
      childSessionKey: "agent:codex:acp:child-1",
    });

    expect(resolved).toBe("/tmp/openclaw/agents/codex/sessions/sess-123.acp-stream.jsonl");
    expect(readAcpSessionEntryMock).toHaveBeenCalledWith({
      sessionKey: "agent:codex:acp:child-1",
    });
    expect(resolveSessionFilePathMock).toHaveBeenCalledWith(
      "sess-123",
      expect.objectContaining({
        sessionId: "sess-123",
      }),
      expect.objectContaining({
        storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      }),
    );
  });
});
