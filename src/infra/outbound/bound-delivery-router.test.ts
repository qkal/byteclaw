import { beforeEach, describe, expect, it } from "vitest";
import { createBoundDeliveryRouter } from "./bound-delivery-router.js";
import {
  type SessionBindingRecord,
  __testing,
  registerSessionBindingAdapter,
} from "./session-binding-service.js";

const TARGET_SESSION_KEY = "agent:main:subagent:child";

function createDiscordBinding(
  targetSessionKey: string,
  conversationId: string,
  boundAt: number,
  parentConversationId?: string,
): SessionBindingRecord {
  return {
    bindingId: `runtime:${conversationId}`,
    boundAt,
    conversation: {
      accountId: "runtime",
      channel: "discord",
      conversationId,
      parentConversationId,
    },
    status: "active",
    targetKind: "subagent",
    targetSessionKey,
  };
}

function registerDiscordSessionBindings(
  targetSessionKey: string,
  bindings: SessionBindingRecord[],
): void {
  registerSessionBindingAdapter({
    accountId: "runtime",
    channel: "discord",
    listBySession: (requestedSessionKey) =>
      requestedSessionKey === targetSessionKey ? bindings : [],
    resolveByConversation: () => null,
  });
}

describe("bound delivery router", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  const resolveDestination = (params: {
    targetSessionKey?: string;
    bindings?: SessionBindingRecord[];
    requesterConversationId?: string;
    failClosed?: boolean;
  }) => {
    if (params.bindings) {
      registerDiscordSessionBindings(
        params.targetSessionKey ?? TARGET_SESSION_KEY,
        params.bindings,
      );
    }
    return createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: params.targetSessionKey ?? TARGET_SESSION_KEY,
      ...(params.requesterConversationId !== undefined
        ? {
            requester: {
              accountId: "runtime",
              channel: "discord",
              conversationId: params.requesterConversationId,
            },
          }
        : {}),
      failClosed: params.failClosed ?? false,
    });
  };

  it.each([
    {
      bindings: [createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1, "parent-1")],
      expected: {
        mode: "bound",
      },
      expectedConversationId: "thread-1",
      name: "resolves to a bound destination when a single active binding exists",
      requesterConversationId: "parent-1",
    },
    {
      expected: {
        binding: null,
        mode: "fallback",
        reason: "no-active-binding",
      },
      name: "falls back when no active binding exists",
      requesterConversationId: "parent-1",
      targetSessionKey: "agent:main:subagent:missing",
    },
    {
      bindings: [
        createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
        createDiscordBinding(TARGET_SESSION_KEY, "thread-2", 2),
      ],
      expected: {
        binding: null,
        mode: "fallback",
        reason: "ambiguous-without-requester",
      },
      failClosed: true,
      name: "fails closed when multiple bindings exist without requester signal",
    },
    {
      bindings: [
        createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
        createDiscordBinding(TARGET_SESSION_KEY, "thread-2", 2),
      ],
      expected: {
        mode: "bound",
        reason: "requester-match",
      },
      expectedConversationId: "thread-2",
      failClosed: true,
      name: "selects requester-matching conversation when multiple bindings exist",
      requesterConversationId: "thread-2",
    },
    {
      bindings: [createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1)],
      expected: {
        binding: null,
        mode: "fallback",
        reason: "invalid-requester",
      },
      failClosed: true,
      name: "falls back for invalid requester conversation values",
      requesterConversationId: " ",
    },
  ])(
    "$name",
    ({
      targetSessionKey,
      bindings,
      requesterConversationId,
      failClosed,
      expected,
      expectedConversationId,
    }) => {
      const route = resolveDestination({
        bindings,
        failClosed,
        requesterConversationId,
        targetSessionKey,
      });

      expect(route).toMatchObject(expected);
      if (expectedConversationId !== undefined) {
        expect(route.binding?.conversation.conversationId).toBe(expectedConversationId);
      }
    },
  );
});
