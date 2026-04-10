import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applyResetModelOverride } from "./session-reset-model.js";

const modelCatalog: ModelCatalogEntry[] = [
  { id: "m2.7", name: "M2.7", provider: "minimax" },
  { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "openai" },
];

function createResetFixture(entry: Partial<SessionEntry> = {}) {
  const cfg = {} as OpenClawConfig;
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
  const sessionEntry: SessionEntry = {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...entry,
  };
  return {
    aliasIndex,
    cfg,
    ctx: { ChatType: "direct" },
    sessionCtx: { BodyStripped: "minimax summarize" },
    sessionEntry,
    sessionStore: { "agent:main:dm:1": sessionEntry } as Record<string, SessionEntry>,
  };
}

async function applyResetFixture(params: {
  resetTriggered: boolean;
  sessionEntry?: Partial<SessionEntry>;
}) {
  const fixture = createResetFixture(params.sessionEntry);
  await applyResetModelOverride({
    aliasIndex: fixture.aliasIndex,
    bodyStripped: "minimax summarize",
    cfg: fixture.cfg,
    ctx: fixture.ctx,
    defaultModel: "gpt-4o-mini",
    defaultProvider: "openai",
    modelCatalog,
    resetTriggered: params.resetTriggered,
    sessionCtx: fixture.sessionCtx,
    sessionEntry: fixture.sessionEntry,
    sessionKey: "agent:main:dm:1",
    sessionStore: fixture.sessionStore,
  });
  return fixture;
}

describe("applyResetModelOverride", () => {
  it("selects a model hint and strips it from the body", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: true,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.7");
    expect(sessionCtx.BodyStripped).toBe("summarize");
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    const { sessionEntry } = await applyResetFixture({
      resetTriggered: true,
      sessionEntry: {
        authProfileOverride: "anthropic:default",
        authProfileOverrideCompactionCount: 2,
        authProfileOverrideSource: "user",
      },
    });

    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("skips when resetTriggered is false", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: false,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});
