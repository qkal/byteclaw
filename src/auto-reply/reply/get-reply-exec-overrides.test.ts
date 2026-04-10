import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";
import { type ReplyExecOverrides, resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";

const AGENT_EXEC_DEFAULTS = {
  ask: "always",
  host: "node",
  node: "worker-alpha",
  security: "allowlist",
} as const satisfies ReplyExecOverrides;

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "main",
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function persistExecDirective(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  body: string;
}) {
  await persistInlineDirectives({
    agentCfg: undefined,
    agentDir: "/tmp/agent",
    aliasIndex: { byAlias: new Map(), byKey: new Map() } satisfies ModelAliasIndex,
    allowedModelKeys: new Set(),
    cfg: { commands: { text: true } } as OpenClawConfig,
    defaultModel: "claude-opus-4-6",
    defaultProvider: "anthropic",
    directives: parseInlineDirectives(params.body),
    elevatedAllowed: false,
    elevatedEnabled: false,
    formatModelSwitchEvent: (label) => label,
    initialModelLabel: "anthropic/claude-opus-4-6",
    model: "claude-opus-4-6",
    provider: "anthropic",
    sessionEntry: params.sessionEntry,
    sessionKey: "agent:main:main",
    sessionStore: params.sessionStore,
    surface: "whatsapp",
  });
}

describe("reply exec overrides", () => {
  it("uses per-agent exec defaults when session and message are unset", () => {
    expect(
      resolveReplyExecOverrides({
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
      }),
    ).toEqual(AGENT_EXEC_DEFAULTS);
  });

  it("prefers inline exec directives, then persisted session overrides, then agent defaults", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execSecurity: "deny",
    });

    expect(
      resolveReplyExecOverrides({
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
        directives: parseInlineDirectives("/exec host=auto security=full"),
        sessionEntry,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "auto",
      security: "full",
    });

    expect(
      resolveReplyExecOverrides({
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "gateway",
      security: "deny",
    });
  });

  it("resolves the latest persisted exec directive for later turns", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { "agent:main:main": sessionEntry };

    await persistExecDirective({
      body: "/exec host=gateway security=deny ask=off",
      sessionEntry,
      sessionStore,
    });
    await persistExecDirective({
      body: "/exec host=gateway security=full ask=always",
      sessionEntry,
      sessionStore,
    });

    expect(
      resolveReplyExecOverrides({
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      ask: "always",
      host: "gateway",
      security: "full",
    });
  });
});
