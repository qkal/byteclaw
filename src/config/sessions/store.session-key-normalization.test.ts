import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  recordSessionMetaFromInbound,
  updateLastRoute,
} from "../sessions.js";

const CANONICAL_KEY = "agent:main:webchat:dm:mixed-user";
const MIXED_CASE_KEY = "Agent:Main:WebChat:DM:MiXeD-User";

function createInboundContext(): MsgContext {
  return {
    ChatType: "direct",
    From: "WebChat:User-1",
    OriginatingTo: "webchat:user-1",
    Provider: "webchat",
    SessionKey: MIXED_CASE_KEY,
    Surface: "webchat",
    To: "webchat:agent",
  };
}

describe("session store key normalization", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-session-key-normalize-",
  });
  let tempDir = "";
  let storePath = "";

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    tempDir = await suiteRootTracker.make("case");
    storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf8");
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("records inbound metadata under a canonical lowercase key", async () => {
    await recordSessionMetaFromInbound({
      ctx: createInboundContext(),
      sessionKey: MIXED_CASE_KEY,
      storePath,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });

  it("does not create a duplicate mixed-case key when last route is updated", async () => {
    await recordSessionMetaFromInbound({
      ctx: createInboundContext(),
      sessionKey: CANONICAL_KEY,
      storePath,
    });

    await updateLastRoute({
      channel: "webchat",
      sessionKey: MIXED_CASE_KEY,
      storePath,
      to: "webchat:user-1",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]).toEqual(
      expect.objectContaining({
        lastChannel: "webchat",
        lastTo: "webchat:user-1",
      }),
    );
  });

  it("migrates legacy mixed-case entries to the canonical key on update", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [MIXED_CASE_KEY]: {
            channel: "webchat",
            chatType: "direct",
            sessionId: "legacy-session",
            updatedAt: 1,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    clearSessionStoreCacheForTest();

    await updateLastRoute({
      channel: "webchat",
      sessionKey: CANONICAL_KEY,
      storePath,
      to: "webchat:user-2",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[CANONICAL_KEY]?.sessionId).toBe("legacy-session");
    expect(store[MIXED_CASE_KEY]).toBeUndefined();
  });

  it("preserves updatedAt when recording inbound metadata for an existing session", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [CANONICAL_KEY]: {
            channel: "webchat",
            chatType: "direct",
            origin: {
              chatType: "direct",
              from: "WebChat:User-1",
              provider: "webchat",
              to: "webchat:user-1",
            },
            sessionId: "existing-session",
            updatedAt: 1111,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    clearSessionStoreCacheForTest();

    await recordSessionMetaFromInbound({
      ctx: createInboundContext(),
      sessionKey: CANONICAL_KEY,
      storePath,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[CANONICAL_KEY]?.sessionId).toBe("existing-session");
    expect(store[CANONICAL_KEY]?.updatedAt).toBe(1111);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });
});
