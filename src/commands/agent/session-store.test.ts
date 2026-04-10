import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateSessionStoreAfterAgentRun } from "../../agents/command/session-store.js";
import { resolveSession } from "../../agents/command/session.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";

function acpMeta() {
  return {
    agent: "codex",
    backend: "acpx",
    lastActivityAt: Date.now(),
    mode: "persistent" as const,
    runtimeSessionName: "runtime-1",
    state: "idle" as const,
  };
}

describe("updateSessionStoreAfterAgentRun", () => {
  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:acp:${randomUUID()}`;
    const sessionId = randomUUID();

    const existing: SessionEntry = {
      acp: acpMeta(),
      sessionId,
      updatedAt: Date.now(),
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: existing }, null, 2), "utf8");

    const staleInMemory: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      defaultModel: "gpt-5.4",
      defaultProvider: "openai",
      result: {
        meta: {
          aborted: false,
          agentMeta: {
            model: "gpt-5.4",
            provider: "openai",
          },
        },
        payloads: [],
      } as never,
      sessionId,
      sessionKey,
      sessionStore: staleInMemory,
      storePath,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.acp).toBeDefined();
    expect(staleInMemory[sessionKey]?.acp).toBeDefined();
  });

  it("persists latest systemPromptReport for downstream warning dedupe", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:report:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

    const report = {
      bootstrapTruncation: {
        warningMode: "once" as const,
        warningSignaturesSeen: ["sig-a", "sig-b"],
      },
      generatedAt: Date.now(),
      injectedWorkspaceFiles: [],
      skills: { entries: [], promptChars: 0 },
      source: "run" as const,
      systemPrompt: {
        chars: 1,
        nonProjectContextChars: 0,
        projectContextChars: 1,
      },
      tools: { entries: [], listChars: 0, schemaChars: 0 },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      defaultModel: "gpt-5.4",
      defaultProvider: "openai",
      result: {
        meta: {
          agentMeta: {
            model: "gpt-5.4",
            provider: "openai",
          },
          systemPromptReport: report,
        },
        payloads: [],
      } as never,
      sessionId,
      sessionKey,
      sessionStore,
      storePath,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
      "sig-a",
      "sig-b",
    ]);
    expect(sessionStore[sessionKey]?.systemPromptReport?.bootstrapTruncation?.warningMode).toBe(
      "once",
    );
  });

  it("stores and reloads the runtime model for explicit session-id-only runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {},
          },
        },
      },
      session: {
        mainKey: "main",
        store: storePath,
      },
    } as never;

    const first = resolveSession({
      cfg,
      sessionId: "explicit-session-123",
    });

    expect(first.sessionKey).toBe("agent:main:explicit:explicit-session-123");

    await updateSessionStoreAfterAgentRun({
      cfg,
      defaultModel: "claude-sonnet-4-6",
      defaultProvider: "claude-cli",
      result: {
        meta: {
          agentMeta: {
            cliSessionBinding: {
              authEpoch: "auth-epoch-1",
              sessionId: "claude-cli-session-1",
            },
            model: "claude-sonnet-4-6",
            provider: "claude-cli",
            sessionId: "claude-cli-session-1",
          },
        },
        payloads: [],
      } as never,
      sessionId: first.sessionId,
      sessionKey: first.sessionKey!,
      sessionStore: first.sessionStore!,
      storePath: first.storePath,
    });

    const second = resolveSession({
      cfg,
      sessionId: "explicit-session-123",
    });

    expect(second.sessionKey).toBe(first.sessionKey);
    expect(second.sessionEntry?.cliSessionBindings?.["claude-cli"]).toEqual({
      authEpoch: "auth-epoch-1",
      sessionId: "claude-cli-session-1",
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[first.sessionKey!];
    expect(persisted?.cliSessionBindings?.["claude-cli"]).toEqual({
      authEpoch: "auth-epoch-1",
      sessionId: "claude-cli-session-1",
    });
  });
});
