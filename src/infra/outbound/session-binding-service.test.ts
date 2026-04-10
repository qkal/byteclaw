import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  type SessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
  __testing,
  getSessionBindingService,
  isSessionBindingError,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "./session-binding-service.js";

type SessionBindingServiceModule = typeof import("./session-binding-service.js");

const sessionBindingServiceModuleUrl = new URL("session-binding-service.ts", import.meta.url).href;

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
          id: "slack",
          meta: { aliases: [] },
        },
        pluginId: "slack",
        source: "test",
      },
      {
        plugin: {
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
          id: "msteams",
          meta: { aliases: [] },
        },
        pluginId: "msteams",
        source: "test",
      },
    ]),
  );
}

async function importSessionBindingServiceModule(
  cacheBust: string,
): Promise<SessionBindingServiceModule> {
  return (await import(
    `${sessionBindingServiceModuleUrl}?t=${cacheBust}`
  )) as SessionBindingServiceModule;
}

function createRecord(input: SessionBindingBindInput): SessionBindingRecord {
  const conversationId =
    input.placement === "child"
      ? "thread-created"
      : input.conversation.conversationId.trim() || "thread-current";
  return {
    bindingId: `default:${conversationId}`,
    boundAt: 1,
    conversation: {
      accountId: "default",
      channel: "demo-binding",
      conversationId,
      parentConversationId: input.conversation.parentConversationId?.trim() || undefined,
    },
    status: "active",
    targetKind: input.targetKind,
    targetSessionKey: input.targetSessionKey,
  };
}

describe("session binding service", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
    setMinimalCurrentConversationRegistry();
  });

  it("normalizes conversation refs and infers current placement", async () => {
    const bind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    registerSessionBindingAdapter({
      accountId: "default",
      bind,
      channel: "demo-binding",
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const result = await getSessionBindingService().bind({
      conversation: {
        accountId: "DEFAULT",
        channel: "Demo-Binding",
        conversationId: " thread-1 ",
      },
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
    });

    expect(result.conversation.channel).toBe("demo-binding");
    expect(result.conversation.accountId).toBe("default");
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "demo-binding",
          conversationId: "thread-1",
        }),
        placement: "current",
      }),
    );
  });

  it("supports explicit child placement when adapter advertises it", async () => {
    registerSessionBindingAdapter({
      accountId: "default",
      bind: async (input) => createRecord(input),
      capabilities: { placements: ["child"] },
      channel: "demo-binding",
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const result = await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "demo-binding",
        conversationId: "thread-1",
      },
      placement: "child",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:1",
    });

    expect(result.conversation.conversationId).toBe("thread-created");
  });

  it("returns structured errors when adapter is unavailable", async () => {
    await expect(
      getSessionBindingService().bind({
        conversation: {
          accountId: "default",
          channel: "demo-binding",
          conversationId: "thread-1",
        },
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-1",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_ADAPTER_UNAVAILABLE",
    });
  });

  it("returns structured errors for unsupported placement", async () => {
    registerSessionBindingAdapter({
      accountId: "default",
      bind: async (input) => createRecord(input),
      capabilities: { placements: ["current"] },
      channel: "demo-binding",
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const rejected = await getSessionBindingService()
      .bind({
        conversation: {
          accountId: "default",
          channel: "demo-binding",
          conversationId: "thread-1",
        },
        placement: "child",
        targetKind: "session",
        targetSessionKey: "agent:codex:acp:1",
      })
      .catch((error) => error);

    expect(isSessionBindingError(rejected)).toBe(true);
    expect(rejected).toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
      details: {
        placement: "child",
      },
    });
  });

  it("returns structured errors when adapter bind fails", async () => {
    registerSessionBindingAdapter({
      accountId: "default",
      bind: async () => null,
      channel: "demo-binding",
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    await expect(
      getSessionBindingService().bind({
        conversation: {
          accountId: "default",
          channel: "demo-binding",
          conversationId: "thread-1",
        },
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-1",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("reports adapter capabilities for command preflight messaging", () => {
    registerSessionBindingAdapter({
      accountId: "default",
      bind: async (input) => createRecord(input),
      capabilities: {
        placements: ["current", "child"],
      },
      channel: "demo-binding",
      listBySession: () => [],
      resolveByConversation: () => null,
      unbind: async () => [],
    });

    const known = getSessionBindingService().getCapabilities({
      accountId: "default",
      channel: "demo-binding",
    });
    const unknown = getSessionBindingService().getCapabilities({
      accountId: "other",
      channel: "demo-binding",
    });

    expect(known).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current", "child"],
      unbindSupported: true,
    });
    expect(unknown).toEqual({
      adapterAvailable: false,
      bindSupported: false,
      placements: [],
      unbindSupported: false,
    });
  });

  it("falls back to generic current-conversation bindings for built-in channels", async () => {
    const service = getSessionBindingService();

    expect(
      service.getCapabilities({
        accountId: " DEFAULT ",
        channel: "Slack",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current"],
      unbindSupported: true,
    });

    const bound = await service.bind({
      conversation: {
        accountId: " DEFAULT ",
        channel: " Slack ",
        conversationId: " user:U123 ",
      },
      metadata: {
        label: "slack-dm",
      },
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:slack-dm",
      ttlMs: 60_000,
    });

    expect(bound).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      conversation: {
        accountId: "default",
        channel: "slack",
        conversationId: "user:U123",
      },
      metadata: expect.objectContaining({
        label: "slack-dm",
      }),
      status: "active",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:slack-dm",
    });

    const resolved = service.resolveByConversation({
      accountId: "default",
      channel: "slack",
      conversationId: "user:U123",
    });
    expect(resolved).toMatchObject({
      bindingId: bound.bindingId,
      targetSessionKey: "agent:codex:acp:slack-dm",
    });
    expect(service.listBySession("agent:codex:acp:slack-dm")).toEqual([resolved]);

    service.touch(bound.bindingId, 1234);
    expect(
      service.resolveByConversation({
        accountId: "default",
        channel: "slack",
        conversationId: "user:U123",
      })?.metadata,
    ).toEqual(
      expect.objectContaining({
        label: "slack-dm",
        lastActivityAt: 1234,
      }),
    );

    await expect(
      service.unbind({
        reason: "test cleanup",
        targetSessionKey: "agent:codex:acp:slack-dm",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingId: bound.bindingId,
      }),
    ]);
    expect(
      service.resolveByConversation({
        accountId: "default",
        channel: "slack",
        conversationId: "user:U123",
      }),
    ).toBeNull();
  });

  it("supports registered plugin channels through the generic current-conversation path", async () => {
    const service = getSessionBindingService();

    expect(
      service.getCapabilities({
        accountId: "default",
        channel: "msteams",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current"],
      unbindSupported: true,
    });

    await expect(
      service.bind({
        conversation: {
          accountId: "default",
          channel: "msteams",
          conversationId: "19:chatid@thread.v2",
        },
        placement: "child",
        targetKind: "session",
        targetSessionKey: "agent:codex:acp:msteams-room",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
      details: {
        accountId: "default",
        channel: "msteams",
        placement: "child",
      },
    });

    await expect(
      service.bind({
        conversation: {
          accountId: "default",
          channel: "msteams",
          conversationId: "19:chatid@thread.v2",
        },
        targetKind: "session",
        targetSessionKey: "agent:codex:acp:msteams-room",
      }),
    ).resolves.toMatchObject({
      conversation: {
        accountId: "default",
        channel: "msteams",
        conversationId: "19:chatid@thread.v2",
      },
    });
  });

  it("does not advertise generic plugin bindings from a stale global registry when the active channel registry is empty", async () => {
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.channels.push({
      plugin: {
        id: "external-chat",
        meta: { aliases: ["external-chat-alias"] },
      } as never,
    } as never);
    setActivePluginRegistry(activeRegistry);
    const pinnedEmptyChannelRegistry = createEmptyPluginRegistry();
    pinActivePluginChannelRegistry(pinnedEmptyChannelRegistry);

    try {
      const service = getSessionBindingService();
      expect(
        service.getCapabilities({
          accountId: "default",
          channel: "external-chat-alias",
        }),
      ).toEqual({
        adapterAvailable: false,
        bindSupported: false,
        placements: [],
        unbindSupported: false,
      });

      await expect(
        service.bind({
          conversation: {
            accountId: "default",
            channel: "external-chat-alias",
            conversationId: "room-1",
          },
          targetKind: "session",
          targetSessionKey: "agent:codex:acp:external-chat",
        }),
      ).rejects.toMatchObject({
        code: "BINDING_ADAPTER_UNAVAILABLE",
      });
    } finally {
      releasePinnedPluginChannelRegistry(pinnedEmptyChannelRegistry);
    }
  });

  it("keeps the first live adapter authoritative until it unregisters", () => {
    const firstBinding = {
      bindingId: "first-binding",
      boundAt: 1,
      conversation: {
        accountId: "default",
        channel: "demo-binding",
        conversationId: "thread-1",
      },
      status: "active" as const,
      targetKind: "session" as const,
      targetSessionKey: "agent:main",
    };
    const firstAdapter: SessionBindingAdapter = {
      accountId: "default",
      channel: "demo-binding",
      listBySession: (targetSessionKey) =>
        targetSessionKey === "agent:main" ? [firstBinding] : [],
      resolveByConversation: () => null,
    };
    const secondAdapter: SessionBindingAdapter = {
      accountId: "DEFAULT",
      channel: "Demo-Binding",
      listBySession: () => [],
      resolveByConversation: () => null,
    };

    registerSessionBindingAdapter(firstAdapter);
    registerSessionBindingAdapter(secondAdapter);

    expect(getSessionBindingService().listBySession("agent:main")).toEqual([firstBinding]);

    unregisterSessionBindingAdapter({
      accountId: "default",
      adapter: secondAdapter,
      channel: "demo-binding",
    });

    expect(getSessionBindingService().listBySession("agent:main")).toEqual([firstBinding]);

    unregisterSessionBindingAdapter({
      accountId: "default",
      adapter: firstAdapter,
      channel: "demo-binding",
    });

    expect(getSessionBindingService().listBySession("agent:main")).toEqual([]);
  });

  it("shares registered adapters across duplicate module instances", async () => {
    const first = await importSessionBindingServiceModule(`first-${Date.now()}`);
    const second = await importSessionBindingServiceModule(`second-${Date.now()}`);
    const firstBind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    const secondBind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    const firstAdapter: SessionBindingAdapter = {
      accountId: "default",
      bind: firstBind,
      channel: "demo-binding",
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    const secondAdapter: SessionBindingAdapter = {
      accountId: "default",
      bind: secondBind,
      channel: "demo-binding",
      listBySession: () => [],
      resolveByConversation: () => null,
    };

    first.__testing.resetSessionBindingAdaptersForTests();
    first.registerSessionBindingAdapter(firstAdapter);
    second.registerSessionBindingAdapter(secondAdapter);

    expect(second.__testing.getRegisteredAdapterKeys()).toEqual(["demo-binding:default"]);

    await expect(
      second.getSessionBindingService().bind({
        conversation: {
          accountId: "default",
          channel: "demo-binding",
          conversationId: "thread-1",
        },
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-1",
      }),
    ).resolves.toMatchObject({
      conversation: expect.objectContaining({
        accountId: "default",
        channel: "demo-binding",
        conversationId: "thread-1",
      }),
    });
    expect(firstBind).toHaveBeenCalledTimes(1);
    expect(secondBind).not.toHaveBeenCalled();

    first.unregisterSessionBindingAdapter({
      accountId: "default",
      adapter: firstAdapter,
      channel: "demo-binding",
    });

    await expect(
      second.getSessionBindingService().bind({
        conversation: {
          accountId: "default",
          channel: "demo-binding",
          conversationId: "thread-2",
        },
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-2",
      }),
    ).resolves.toMatchObject({
      conversation: expect.objectContaining({
        accountId: "default",
        channel: "demo-binding",
        conversationId: "thread-2",
      }),
    });
    expect(firstBind).toHaveBeenCalledTimes(1);
    expect(secondBind).toHaveBeenCalledTimes(1);

    second.unregisterSessionBindingAdapter({
      accountId: "default",
      adapter: secondAdapter,
      channel: "demo-binding",
    });

    await expect(
      second.getSessionBindingService().bind({
        conversation: {
          accountId: "default",
          channel: "demo-binding",
          conversationId: "thread-3",
        },
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-3",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_ADAPTER_UNAVAILABLE",
    });

    first.__testing.resetSessionBindingAdaptersForTests();
  });
});
