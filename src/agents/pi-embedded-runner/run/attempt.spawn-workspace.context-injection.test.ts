import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { filterHeartbeatPairs } from "../../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import { limitHistoryTurns } from "../history.js";
import {
  type AttemptContextEngine,
  assembleAttemptContextEngine,
  resolveAttemptBootstrapContext,
} from "./attempt.context-engine-helpers.js";

async function resolveBootstrapContext(params: {
  contextInjectionMode?: "always" | "continuation-skip";
  bootstrapContextMode?: string;
  bootstrapContextRunKind?: string;
  completed?: boolean;
  resolver?: () => Promise<{ bootstrapFiles: unknown[]; contextFiles: unknown[] }>;
}) {
  const hasCompletedBootstrapTurn = vi.fn(async () => params.completed ?? false);
  const resolveBootstrapContextForRun =
    params.resolver ??
    vi.fn(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    }));

  const result = await resolveAttemptBootstrapContext({
    bootstrapContextMode: params.bootstrapContextMode ?? "full",
    bootstrapContextRunKind: params.bootstrapContextRunKind ?? "default",
    contextInjectionMode: params.contextInjectionMode ?? "always",
    hasCompletedBootstrapTurn,
    resolveBootstrapContextForRun,
    sessionFile: "/tmp/session.jsonl",
  });

  return { hasCompletedBootstrapTurn, resolveBootstrapContextForRun, result };
}

describe("embedded attempt context injection", () => {
  it("skips bootstrap reinjection on safe continuation turns when configured", async () => {
    const { result, hasCompletedBootstrapTurn, resolveBootstrapContextForRun } =
      await resolveBootstrapContext({
        completed: true,
        contextInjectionMode: "continuation-skip",
      });

    expect(result.isContinuationTurn).toBe(true);
    expect(result.bootstrapFiles).toEqual([]);
    expect(result.contextFiles).toEqual([]);
    expect(hasCompletedBootstrapTurn).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(resolveBootstrapContextForRun).not.toHaveBeenCalled();
  });

  it("still resolves bootstrap context when continuation-skip has no completed assistant turn yet", async () => {
    const resolver = vi.fn(async () => ({
      bootstrapFiles: [{ name: "AGENTS.md" }],
      contextFiles: [{ path: "AGENTS.md" }],
    }));

    const { result } = await resolveBootstrapContext({
      completed: false,
      contextInjectionMode: "continuation-skip",
      resolver,
    });

    expect(result.isContinuationTurn).toBe(false);
    expect(result.bootstrapFiles).toEqual([{ name: "AGENTS.md" }]);
    expect(result.contextFiles).toEqual([{ path: "AGENTS.md" }]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("never skips heartbeat bootstrap filtering", async () => {
    const { result, hasCompletedBootstrapTurn, resolveBootstrapContextForRun } =
      await resolveBootstrapContext({
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "heartbeat",
        completed: true,
        contextInjectionMode: "continuation-skip",
      });

    expect(result.isContinuationTurn).toBe(false);
    expect(result.shouldRecordCompletedBootstrapTurn).toBe(false);
    expect(hasCompletedBootstrapTurn).not.toHaveBeenCalled();
    expect(resolveBootstrapContextForRun).toHaveBeenCalledTimes(1);
  });

  it("runs full bootstrap injection after a successful non-heartbeat turn", async () => {
    const resolver = vi.fn(async () => ({
      bootstrapFiles: [{ content: "bootstrap context", name: "AGENTS.md" }],
      contextFiles: [{ content: "bootstrap context", path: "AGENTS.md" }],
    }));

    const { result } = await resolveBootstrapContext({
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "default",
      resolver,
    });

    expect(result.shouldRecordCompletedBootstrapTurn).toBe(true);
    expect(result.bootstrapFiles).toEqual([{ content: "bootstrap context", name: "AGENTS.md" }]);
  });

  it("does not record full bootstrap completion for heartbeat runs", async () => {
    const { result } = await resolveBootstrapContext({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "heartbeat",
    });

    expect(result.shouldRecordCompletedBootstrapTurn).toBe(false);
  });

  it("filters no-op heartbeat pairs before history limiting and context-engine assembly", async () => {
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      estimatedTokens: 1,
      messages,
    }));
    const sessionMessages: AgentMessage[] = [
      { content: "real question", role: "user", timestamp: 1 } as AgentMessage,
      { content: "real answer", role: "assistant", timestamp: 2 } as unknown as AgentMessage,
      { content: HEARTBEAT_PROMPT, role: "user", timestamp: 3 } as AgentMessage,
      { content: "HEARTBEAT_OK", role: "assistant", timestamp: 4 } as unknown as AgentMessage,
    ];

    const heartbeatFiltered = filterHeartbeatPairs(sessionMessages, undefined, HEARTBEAT_PROMPT);
    const limited = limitHistoryTurns(heartbeatFiltered, 1);
    await assembleAttemptContextEngine({
      contextEngine: {
        assemble,
        compact: async () => ({ ok: false, compacted: false, reason: "unused" }),
        info: { id: "test", name: "Test", version: "0.0.1" },
        ingest: async () => ({ ingested: true }),
      } satisfies AttemptContextEngine,
      messages: limited,
      modelId: "gpt-test",
      sessionId: "session",
      sessionKey: "agent:main:discord:dm:test-user",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ content: "real question", role: "user" }),
          expect.objectContaining({ content: "real answer", role: "assistant" }),
        ],
      }),
    );
  });
});
