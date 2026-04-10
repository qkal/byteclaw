import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

const setRegistry = (registry: ReturnType<typeof createTestRegistry>) => {
  setActivePluginRegistry(registry);
};

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  callGatewayLeastPrivilege: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

let sendMessage: typeof import("./message.js").sendMessage;
let sendPoll: typeof import("./message.js").sendPoll;

beforeAll(async () => {
  ({ sendMessage, sendPoll } = await import("./message.js"));
});

beforeEach(() => {
  callGatewayMock.mockClear();
  setRegistry(emptyRegistry);
});

afterEach(() => {
  setRegistry(emptyRegistry);
});

const gatewayCall = () =>
  callGatewayMock.mock.calls[0]?.[0] as {
    url?: string;
    token?: string;
    timeoutMs?: number;
    params?: Record<string, unknown>;
  };

describe("sendMessage channel normalization", () => {
  it("threads resolved cfg through alias + target normalization in outbound dispatch", async () => {
    const resolvedCfg = {
      __resolvedCfgMarker: "cfg-from-secret-resolution",
      channels: {},
    } as Record<string, unknown>;
    const seen: {
      resolveCfg?: unknown;
      sendCfg?: unknown;
      to?: string;
    } = {};
    const imessageAliasPlugin: ChannelPlugin = {
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      id: "imessage",
      meta: {
        aliases: ["imsg"],
        blurb: "iMessage test stub.",
        docsPath: "/channels/imessage",
        id: "imessage",
        label: "iMessage",
        selectionLabel: "iMessage",
      },
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to, cfg }) => {
          seen.resolveCfg = cfg;
          const normalized = String(to ?? "")
            .trim()
            .replace(/^imessage:/i, "");
          return { ok: true, to: normalized };
        },
        sendMedia: async ({ cfg, to }) => {
          seen.sendCfg = cfg;
          seen.to = to;
          return { channel: "imessage", messageId: "i-resolved-media" };
        },
        sendText: async ({ cfg, to }) => {
          seen.sendCfg = cfg;
          seen.to = to;
          return { channel: "imessage", messageId: "i-resolved" };
        },
      },
    };

    setRegistry(
      createTestRegistry([
        {
          plugin: imessageAliasPlugin,
          pluginId: "imessage",
          source: "test",
        },
      ]),
    );

    const result = await sendMessage({
      cfg: resolvedCfg,
      channel: "imsg",
      content: "hi",
      to: " imessage:+15551234567 ",
    });

    expect(result.channel).toBe("imessage");
    expect(seen.resolveCfg).toBe(resolvedCfg);
    expect(seen.sendCfg).toBe(resolvedCfg);
    expect(seen.to).toBe("+15551234567");
  });

  it.each([
    {
      assertDeps: (deps: { "demo-alias-channel"?: ReturnType<typeof vi.fn> }) => {
        expect(deps["demo-alias-channel"]).toHaveBeenCalledWith("conversation:demo-target", "hi");
      },
      expectedChannel: "demo-alias-channel",
      name: "normalizes plugin aliases",
      params: {
        channel: "workspace-chat",
        deps: {
          "demo-alias-channel": vi.fn(async () => ({
            conversationId: "c1",
            messageId: "m1",
          })),
        },
        to: "conversation:demo-target",
      },
      registry: createTestRegistry([
        {
          plugin: createDemoAliasPlugin({
            outbound: createDemoAliasOutbound(),
            aliases: ["workspace-chat"],
          }),
          pluginId: "demo-alias-channel",
          source: "test",
        },
      ]),
    },
    {
      assertDeps: (deps: { imessage?: ReturnType<typeof vi.fn> }) => {
        expect(deps.imessage).toHaveBeenCalledWith("someone@example.com", "hi", expect.any(Object));
      },
      expectedChannel: "imessage",
      name: "normalizes iMessage aliases",
      params: {
        channel: "imsg",
        deps: {
          imessage: vi.fn(async () => ({ messageId: "i1" })),
        },
        to: "someone@example.com",
      },
      registry: createTestRegistry([
        {
          plugin: createIMessageAliasPlugin(),
          pluginId: "imessage",
          source: "test",
        },
      ]),
    },
  ])("$name", async ({ registry, params, assertDeps, expectedChannel }) => {
    setRegistry(registry);

    const result = await sendMessage({
      cfg: {},
      content: "hi",
      ...params,
    });

    assertDeps(params.deps);
    expect(result.channel).toBe(expectedChannel);
  });
});

describe("sendMessage replyToId threading", () => {
  const setupMattermostCapture = () => {
    const capturedCtx: Record<string, unknown>[] = [];
    const plugin = createMattermostLikePlugin({
      onSendText: (ctx) => {
        capturedCtx.push(ctx);
      },
    });
    setRegistry(createTestRegistry([{ plugin, pluginId: "mattermost", source: "test" }]));
    return capturedCtx;
  };

  it.each([
    {
      expected: "post123",
      field: "replyToId",
      name: "passes replyToId through to the outbound adapter",
      params: { content: "thread reply", replyToId: "post123" },
    },
    {
      expected: "topic456",
      field: "threadId",
      name: "passes threadId through to the outbound adapter",
      params: { content: "topic reply", threadId: "topic456" },
    },
  ])("$name", async ({ params, field, expected }) => {
    const capturedCtx = setupMattermostCapture();

    await sendMessage({
      cfg: {},
      channel: "mattermost",
      to: "channel:town-square",
      ...params,
    });

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0]?.[field]).toBe(expected);
  });
});

describe("sendPoll channel normalization", () => {
  it("normalizes plugin aliases for polls", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1" });
    setRegistry(
      createTestRegistry([
        {
          plugin: createDemoAliasPlugin({
            aliases: ["workspace-chat"],
            outbound: createDemoAliasOutbound({ includePoll: true }),
          }),
          pluginId: "demo-alias-channel",
          source: "test",
        },
      ]),
    );

    const result = await sendPoll({
      cfg: {},
      channel: "Workspace-Chat",
      options: ["Pizza", "Sushi"],
      question: "Lunch?",
      to: "conversation:demo-target",
    });

    expect(gatewayCall()?.params?.channel).toBe("demo-alias-channel");
    expect(result.channel).toBe("demo-alias-channel");
  });
});

const setMattermostGatewayRegistry = () => {
  setRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createMattermostLikePlugin({ onSendText: () => {} }),
          outbound: { deliveryMode: "gateway" },
        },
        pluginId: "mattermost",
        source: "test",
      },
    ]),
  );
};

describe("gateway url override hardening", () => {
  const sendMattermostGatewayMessage = async (
    params: Partial<Parameters<typeof sendMessage>[0]> = {},
  ) => {
    setMattermostGatewayRegistry();
    callGatewayMock.mockResolvedValueOnce({
      messageId: params.agentId ? "m-agent" : "m1",
    });
    await sendMessage({
      cfg: {},
      channel: "mattermost",
      content: "hi",
      to: "channel:town-square",
      ...params,
    });
    return gatewayCall();
  };

  it.each([
    {
      expected: {
        timeoutMs: 5000,
        token: "t",
        url: undefined,
      },
      name: "drops gateway url overrides in backend mode (SSRF hardening)",
      params: {
        gateway: {
          clientDisplayName: "agent",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          timeoutMs: 5000,
          token: "t",
          url: "ws://169.254.169.254:80/latest/meta-data/",
        },
      },
    },
    {
      expected: {
        params: {
          agentId: "work",
        },
      },
      name: "forwards explicit agentId in gateway send params",
      params: {
        agentId: "work",
      },
    },
  ])("$name", async ({ params, expected }) => {
    expect(await sendMattermostGatewayMessage(params)).toMatchObject(expected);
  });
});

const emptyRegistry = createTestRegistry([]);

const createDemoAliasPlugin = (params?: {
  aliases?: string[];
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => {
  const base = createChannelTestPluginBase({
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    docsPath: "/channels/demo-alias-channel",
    id: "demo-alias-channel",
    label: "Demo Alias Channel",
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(params?.aliases ? { aliases: params.aliases } : {}),
    },
    ...(params?.outbound ? { outbound: params.outbound } : {}),
  };
};

const createIMessageAliasPlugin = (): ChannelPlugin => ({
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  id: "imessage",
  meta: {
    aliases: ["imsg"],
    blurb: "iMessage test stub.",
    docsPath: "/channels/imessage",
    id: "imessage",
    label: "iMessage",
    selectionLabel: "iMessage (imsg)",
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ deps, to, text }) => {
      const send = deps?.imessage as
        | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
        | undefined;
      if (!send) {
        throw new Error("imessage missing");
      }
      const result = await send(to, text, {});
      return { channel: "imessage", ...result };
    },
  },
});

const createDemoAliasOutbound = (opts?: { includePoll?: boolean }): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    const send = deps?.["demo-alias-channel"] as
      | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
      | undefined;
    if (!send) {
      throw new Error("demo-alias-channel missing");
    }
    const result = await send(to, text, { mediaUrl });
    return { channel: "demo-alias-channel", ...result };
  },
  sendText: async ({ deps, to, text }) => {
    const send = deps?.["demo-alias-channel"] as
      | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
      | undefined;
    if (!send) {
      throw new Error("demo-alias-channel missing");
    }
    const result = await send(to, text);
    return { channel: "demo-alias-channel", ...result };
  },
  ...(opts?.includePoll
    ? {
        pollMaxOptions: 12,
        sendPoll: async () => ({ channel: "demo-alias-channel", messageId: "p1" }),
      }
    : {}),
});

const createMattermostLikePlugin = (opts: {
  onSendText: (ctx: Record<string, unknown>) => void;
}): ChannelPlugin => ({
  capabilities: { chatTypes: ["direct", "channel"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
  },
  id: "mattermost",
  meta: {
    blurb: "Mattermost test stub.",
    docsPath: "/channels/mattermost",
    id: "mattermost",
    label: "Mattermost",
    selectionLabel: "Mattermost",
  },
  outbound: {
    deliveryMode: "direct",
    sendMedia: async () => ({ channel: "mattermost", messageId: "m2" }),
    sendText: async (ctx) => {
      opts.onSendText(ctx as unknown as Record<string, unknown>);
      return { channel: "mattermost", messageId: "m1" };
    },
  },
});
