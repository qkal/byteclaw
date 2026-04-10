import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord,
} from "./thread-bindings.persona.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

describe("thread binding persona", () => {
  it("prefers explicit label and prefixes with gear", () => {
    expect(resolveThreadBindingPersona({ agentId: "codex", label: "codex thread" })).toBe(
      "⚙️ codex thread",
    );
  });

  it("falls back to agent id when label is missing", () => {
    expect(resolveThreadBindingPersona({ agentId: "codex" })).toBe("⚙️ codex");
  });

  it("builds persona from binding record", () => {
    const record = {
      accountId: "default",
      agentId: "codex",
      boundAt: Date.now(),
      boundBy: "system",
      channelId: "parent-1",
      label: "codex-thread",
      lastActivityAt: Date.now(),
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:session-1",
      threadId: "thread-1",
    } satisfies ThreadBindingRecord;
    expect(resolveThreadBindingPersonaFromRecord(record)).toBe("⚙️ codex-thread");
  });
});
