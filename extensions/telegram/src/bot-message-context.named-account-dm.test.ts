import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getRecordedUpdateLastRoute,
  loadTelegramMessageContextRouteHarness,
  recordInboundSessionMock,
} from "./bot-message-context.route-test-support.js";

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;
let clearRuntimeConfigSnapshot: typeof import("openclaw/plugin-sdk/config-runtime").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("openclaw/plugin-sdk/config-runtime").setRuntimeConfigSnapshot;

describe("buildTelegramMessageContext named-account DM fallback", () => {
  const baseCfg = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  };

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  beforeAll(async () => {
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot, buildTelegramMessageContextForTest } =
      await loadTelegramMessageContextRouteHarness());
  });

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
  });

  function getLastUpdateLastRoute(): { sessionKey?: string } | undefined {
    return getRecordedUpdateLastRoute() as { sessionKey?: string } | undefined;
  }

  function buildNamedAccountDmMessage(messageId = 1) {
    return {
      chat: { id: 814_912_386, type: "private" as const },
      date: 1_700_000_000 + messageId - 1,
      from: { first_name: "Alice", id: 814_912_386 },
      message_id: messageId,
      text: "hello",
    };
  }

  async function buildNamedAccountDmContext(accountId = "atlas", messageId = 1) {
    setRuntimeConfigSnapshot(baseCfg);
    return await buildTelegramMessageContextForTest({
      accountId,
      cfg: baseCfg,
      message: buildNamedAccountDmMessage(messageId),
    });
  }

  it("allows DM through for a named account with no explicit binding", async () => {
    setRuntimeConfigSnapshot(baseCfg);

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "atlas",
      cfg: baseCfg,
      message: {
        chat: { id: 814_912_386, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 814_912_386 },
        message_id: 1,
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.matchedBy).toBe("default");
    expect(ctx?.route.accountId).toBe("atlas");
  });

  it("uses a per-account session key for named-account DMs", async () => {
    const ctx = await buildNamedAccountDmContext();

    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:atlas:direct:814912386");
  });

  it("keeps named-account fallback lastRoute on the isolated DM session", async () => {
    const ctx = await buildNamedAccountDmContext();

    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:atlas:direct:814912386");
    expect(getLastUpdateLastRoute()?.sessionKey).toBe("agent:main:telegram:atlas:direct:814912386");
  });

  it("isolates sessions between named accounts that share the default agent", async () => {
    const atlas = await buildNamedAccountDmContext("atlas", 1);
    const skynet = await buildNamedAccountDmContext("skynet", 2);

    expect(atlas?.ctxPayload?.SessionKey).toBe("agent:main:telegram:atlas:direct:814912386");
    expect(skynet?.ctxPayload?.SessionKey).toBe("agent:main:telegram:skynet:direct:814912386");
    expect(atlas?.ctxPayload?.SessionKey).not.toBe(skynet?.ctxPayload?.SessionKey);
  });

  it("keeps identity-linked peer canonicalization in the named-account fallback path", async () => {
    const cfg = {
      ...baseCfg,
      session: {
        identityLinks: {
          "alice-shared": ["telegram:814912386"],
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "atlas",
      cfg,
      message: {
        chat: { id: 999_999_999, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 814_912_386 },
        message_id: 1,
        text: "hello",
      },
    });

    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:atlas:direct:alice-shared");
  });

  it("still drops named-account group messages without an explicit binding", async () => {
    setRuntimeConfigSnapshot(baseCfg);

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "atlas",
      cfg: baseCfg,
      message: {
        chat: { id: -1_001_234_567_890, title: "Test Group", type: "supergroup" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 814_912_386 },
        message_id: 1,
        text: "@bot hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx).toBeNull();
  });

  it("does not change the default-account DM session key", async () => {
    setRuntimeConfigSnapshot(baseCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: baseCfg,
      message: {
        chat: { id: 42, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 42 },
        message_id: 1,
        text: "hello",
      },
    });

    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});
