import { describe, expect, it } from "vitest";
import {
  resolveAcpSessionCwd,
  resolveAcpSessionIdentifierLinesFromIdentity,
  resolveAcpThreadSessionDetailLines,
} from "./session-identifiers.js";

describe("session identifier helpers", () => {
  it("hides unresolved identifiers from thread intro details while pending", () => {
    const lines = resolveAcpThreadSessionDetailLines({
      meta: {
        agent: "codex",
        backend: "acpx",
        identity: {
          acpxSessionId: "acpx-123",
          agentSessionId: "inner-123",
          lastUpdatedAt: Date.now(),
          source: "ensure",
          state: "pending",
        },
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime-1",
        state: "idle",
      },
      sessionKey: "agent:codex:acp:pending-1",
    });

    expect(lines).toEqual([]);
  });

  it("adds a Codex resume hint when agent identity is resolved", () => {
    const lines = resolveAcpThreadSessionDetailLines({
      meta: {
        agent: "codex",
        backend: "acpx",
        identity: {
          acpxSessionId: "acpx-123",
          agentSessionId: "inner-123",
          lastUpdatedAt: Date.now(),
          source: "status",
          state: "resolved",
        },
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime-1",
        state: "idle",
      },
      sessionKey: "agent:codex:acp:resolved-1",
    });

    expect(lines).toContain("agent session id: inner-123");
    expect(lines).toContain("acpx session id: acpx-123");
    expect(lines).toContain(
      "resume in Codex CLI: `codex resume inner-123` (continues this conversation).",
    );
  });

  it("adds a Kimi resume hint when agent identity is resolved", () => {
    const lines = resolveAcpThreadSessionDetailLines({
      meta: {
        agent: "kimi",
        backend: "acpx",
        identity: {
          acpxSessionId: "acpx-kimi-123",
          agentSessionId: "kimi-inner-123",
          lastUpdatedAt: Date.now(),
          source: "status",
          state: "resolved",
        },
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime-1",
        state: "idle",
      },
      sessionKey: "agent:kimi:acp:resolved-1",
    });

    expect(lines).toContain("agent session id: kimi-inner-123");
    expect(lines).toContain("acpx session id: acpx-kimi-123");
    expect(lines).toContain(
      "resume in Kimi CLI: `kimi resume kimi-inner-123` (continues this conversation).",
    );
  });

  it("shows pending identity text for status rendering", () => {
    const lines = resolveAcpSessionIdentifierLinesFromIdentity({
      backend: "acpx",
      identity: {
        agentSessionId: "inner-123",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "pending",
      },
      mode: "status",
    });

    expect(lines).toEqual(["session ids: pending (available after the first reply)"]);
  });

  it("prefers runtimeOptions.cwd over legacy meta.cwd", () => {
    const cwd = resolveAcpSessionCwd({
      agent: "codex",
      backend: "acpx",
      cwd: "/repo/old",
      lastActivityAt: Date.now(),
      mode: "persistent",
      runtimeOptions: {
        cwd: "/repo/new",
      },
      runtimeSessionName: "runtime-1",
      state: "idle",
    });
    expect(cwd).toBe("/repo/new");
  });
});
