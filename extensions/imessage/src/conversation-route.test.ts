import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  registerSessionBindingAdapter,
  __testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageConversationRoute } from "./conversation-route.js";

const baseCfg = {
  agents: {
    list: [{ id: "main" }, { id: "codex" }],
  },
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("resolveIMessageConversationRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("lets runtime iMessage conversation bindings override default routing", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      accountId: "default",
      channel: "imessage",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "+15555550123"
          ? {
              bindingId: "default:+15555550123",
              boundAt: Date.now(),
              conversation: {
                accountId: "default",
                channel: "imessage",
                conversationId: "+15555550123",
              },
              metadata: { boundBy: "user-1" },
              status: "active",
              targetKind: "session",
              targetSessionKey: "agent:codex:acp:bound-1",
            }
          : null,
      touch,
    });

    const route = resolveIMessageConversationRoute({
      accountId: "default",
      cfg: baseCfg,
      isGroup: false,
      peerId: "+15555550123",
      sender: "+15555550123",
    });

    expect(route.agentId).toBe("codex");
    expect(route.sessionKey).toBe("agent:codex:acp:bound-1");
    expect(route.matchedBy).toBe("binding.channel");
    expect(touch).toHaveBeenCalledWith("default:+15555550123", undefined);
  });
});
