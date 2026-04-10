import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { SessionEntry } from "./types.js";

const storeState = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
}));

vi.mock("../io.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./paths.js", () => ({
  resolveStorePath: () => "/tmp/sessions.json",
}));

vi.mock("./store.js", () => ({
  loadSessionStore: () => storeState.store,
}));

let extractDeliveryInfo: typeof import("./delivery-info.js").extractDeliveryInfo;
let parseSessionThreadInfo: typeof import("./delivery-info.js").parseSessionThreadInfo;

const buildEntry = (deliveryContext: SessionEntry["deliveryContext"]): SessionEntry => ({
  deliveryContext,
  sessionId: "session-1",
  updatedAt: Date.now(),
});

beforeAll(async () => {
  ({ extractDeliveryInfo, parseSessionThreadInfo } = await import("./delivery-info.js"));
});

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
  storeState.store = {};
});

describe("extractDeliveryInfo", () => {
  it("parses base session and thread/topic ids", () => {
    expect(parseSessionThreadInfo("agent:main:telegram:group:1:topic:55")).toEqual({
      baseSessionKey: "agent:main:telegram:group:1",
      threadId: "55",
    });
    expect(parseSessionThreadInfo("agent:main:slack:channel:C1:thread:123.456")).toEqual({
      baseSessionKey: "agent:main:slack:channel:C1",
      threadId: "123.456",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      baseSessionKey: "agent:main:matrix:channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo("agent:main:telegram:dm:user-1")).toEqual({
      baseSessionKey: "agent:main:telegram:dm:user-1",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo(undefined)).toEqual({
      baseSessionKey: undefined,
      threadId: undefined,
    });
  });

  it("returns deliveryContext for direct session keys", () => {
    const sessionKey = "agent:main:webchat:dm:user-123";
    storeState.store[sessionKey] = buildEntry({
      accountId: "default",
      channel: "webchat",
      to: "webchat:user-123",
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        accountId: "default",
        channel: "webchat",
        to: "webchat:user-123",
      },
      threadId: undefined,
    });
  });

  it("falls back to base sessions for :thread: keys", () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    storeState.store[baseKey] = buildEntry({
      accountId: "workspace-1",
      channel: "slack",
      to: "slack:C0123ABC",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        accountId: "workspace-1",
        channel: "slack",
        to: "slack:C0123ABC",
      },
      threadId: "1234567890.123456",
    });
  });

  it("falls back to base sessions for :topic: keys", () => {
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    storeState.store[baseKey] = buildEntry({
      accountId: "main",
      channel: "telegram",
      to: "group:98765",
    });
    storeState.store[baseKey].lastThreadId = "55";

    const result = extractDeliveryInfo(topicKey);

    expect(result).toEqual({
      deliveryContext: {
        accountId: "main",
        channel: "telegram",
        threadId: "55",
        to: "group:98765",
      },
      threadId: "55",
    });
  });

  it("falls back to session metadata thread ids when deliveryContext.threadId is missing", () => {
    const sessionKey = "agent:main:telegram:group:98765";
    storeState.store[sessionKey] = {
      ...buildEntry({
        accountId: "main",
        channel: "telegram",
        to: "group:98765",
      }),
      origin: { threadId: 77 },
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        accountId: "main",
        channel: "telegram",
        threadId: "77",
        to: "group:98765",
      },
      threadId: undefined,
    });
  });
});
