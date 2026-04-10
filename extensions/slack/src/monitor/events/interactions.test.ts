import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    duplicate: false,
    handled: false,
    matched: false,
  })),
);
const resolvePluginConversationBindingApprovalMock = vi.hoisted(() => vi.fn());
const buildPluginBindingResolvedTextMock = vi.hoisted(() => vi.fn(() => "Binding updated."));

let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;
let enqueueSystemEventSpy: ReturnType<typeof vi.spyOn>;
let dispatchPluginInteractiveHandlerSpy: ReturnType<typeof vi.spyOn>;
let resolvePluginConversationBindingApprovalSpy: ReturnType<typeof vi.spyOn>;
let buildPluginBindingResolvedTextSpy: ReturnType<typeof vi.spyOn>;

type RegisteredHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user: { id: string };
    team?: { id?: string };
    trigger_id?: string;
    response_url?: string;
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
    message?: { ts?: string; text?: string; blocks?: unknown[] };
  };
  action: Record<string, unknown>;
  respond?: (payload: { text: string; response_type: string }) => Promise<void>;
}) => Promise<void>;

type RegisteredViewHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user?: { id?: string };
    team?: { id?: string };
    view?: {
      id?: string;
      callback_id?: string;
      private_metadata?: string;
      root_view_id?: string;
      previous_view_id?: string;
      external_id?: string;
      hash?: string;
      state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
    };
  };
}) => Promise<void>;

type RegisteredViewClosedHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user?: { id?: string };
    team?: { id?: string };
    view?: {
      id?: string;
      callback_id?: string;
      private_metadata?: string;
      root_view_id?: string;
      previous_view_id?: string;
      external_id?: string;
      hash?: string;
      state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
    };
    is_cleared?: boolean;
  };
}) => Promise<void>;

function createContext(overrides?: {
  dmEnabled?: boolean;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: string[];
  allowNameMatching?: boolean;
  channelsConfig?: Record<string, { users?: string[] }>;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  isChannelAllowed?: (params: {
    channelId?: string;
    channelName?: string;
    channelType?: "im" | "mpim" | "channel" | "group";
  }) => boolean;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  resolveChannelName?: (channelId: string) => Promise<{
    name?: string;
    type?: "im" | "mpim" | "channel" | "group";
  }>;
}) {
  let handler: RegisteredHandler | null = null;
  let actionMatcher: RegExp | null = null;
  let viewHandler: RegisteredViewHandler | null = null;
  let viewClosedHandler: RegisteredViewClosedHandler | null = null;
  const app = {
    action: vi.fn((matcher: RegExp, next: RegisteredHandler) => {
      actionMatcher = matcher;
      handler = next;
    }),
    client: {
      chat: {
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
    view: vi.fn((_matcher: RegExp, next: RegisteredViewHandler) => {
      viewHandler = next;
    }),
    viewClosed: vi.fn((_matcher: RegExp, next: RegisteredViewClosedHandler) => {
      viewClosedHandler = next;
    }),
  };
  const runtimeLog = vi.fn();
  const resolveSessionKey = vi.fn().mockReturnValue("agent:ops:slack:channel:C1");
  const isChannelAllowed = vi
    .fn<
      (params: {
        channelId?: string;
        channelName?: string;
        channelType?: "im" | "mpim" | "channel" | "group";
      }) => boolean
    >()
    .mockImplementation((params) => overrides?.isChannelAllowed?.(params) ?? true);
  const resolveUserName = vi
    .fn<(userId: string) => Promise<{ name?: string }>>()
    .mockImplementation((userId) => overrides?.resolveUserName?.(userId) ?? Promise.resolve({}));
  const resolveChannelName = vi
    .fn<
      (channelId: string) => Promise<{
        name?: string;
        type?: "im" | "mpim" | "channel" | "group";
      }>
    >()
    .mockImplementation(
      (channelId) => overrides?.resolveChannelName?.(channelId) ?? Promise.resolve({}),
    );
  const ctx = {
    accountId: "default",
    allowFrom: overrides?.allowFrom ?? [],
    allowNameMatching: overrides?.allowNameMatching ?? false,
    app,
    channelsConfig: overrides?.channelsConfig ?? {},
    defaultRequireMention: true,
    dmEnabled: overrides?.dmEnabled ?? true,
    dmPolicy: overrides?.dmPolicy ?? ("open" as const),
    isChannelAllowed,
    resolveChannelName,
    resolveSlackSystemEventSessionKey: resolveSessionKey,
    resolveUserName,
    runtime: { log: runtimeLog },
    shouldDropMismatchedSlackEvent: (body: unknown) =>
      overrides?.shouldDropMismatchedSlackEvent?.(body) ?? false,
  };
  return {
    app,
    ctx,
    getActionMatcher: () => actionMatcher,
    getHandler: () => handler,
    getViewClosedHandler: () => viewClosedHandler,
    getViewHandler: () => viewHandler,
    isChannelAllowed,
    resolveChannelName,
    resolveSessionKey,
    resolveUserName,
    runtimeLog,
  };
}

describe("registerSlackInteractionEvents", () => {
  beforeAll(async () => {
    const channelRuntime = await import("openclaw/plugin-sdk/infra-runtime");
    const pluginRuntime = await import("openclaw/plugin-sdk/plugin-runtime");
    const conversationBinding = await import("../../../../../src/plugins/conversation-binding.js");
    enqueueSystemEventSpy = vi
      .spyOn(channelRuntime, "enqueueSystemEvent")
      .mockImplementation(((...args: Parameters<typeof channelRuntime.enqueueSystemEvent>) =>
        (enqueueSystemEventMock as (...innerArgs: unknown[]) => boolean)(
          ...args,
        )) as typeof channelRuntime.enqueueSystemEvent);
    dispatchPluginInteractiveHandlerSpy = vi
      .spyOn(pluginRuntime, "dispatchPluginInteractiveHandler")
      .mockImplementation(((
        ...args: Parameters<typeof pluginRuntime.dispatchPluginInteractiveHandler>
      ) =>
        (dispatchPluginInteractiveHandlerMock as (...innerArgs: unknown[]) => Promise<unknown>)(
          ...args,
        )) as typeof pluginRuntime.dispatchPluginInteractiveHandler);
    resolvePluginConversationBindingApprovalSpy = vi
      .spyOn(conversationBinding, "resolvePluginConversationBindingApproval")
      .mockImplementation(((
        ...args: Parameters<typeof conversationBinding.resolvePluginConversationBindingApproval>
      ) =>
        (
          resolvePluginConversationBindingApprovalMock as (
            ...innerArgs: unknown[]
          ) => Promise<unknown>
        )(...args)) as typeof conversationBinding.resolvePluginConversationBindingApproval);
    buildPluginBindingResolvedTextSpy = vi
      .spyOn(conversationBinding, "buildPluginBindingResolvedText")
      .mockImplementation(((
        ...args: Parameters<typeof conversationBinding.buildPluginBindingResolvedText>
      ) =>
        (buildPluginBindingResolvedTextMock as (...innerArgs: unknown[]) => string)(
          ...args,
        )) as typeof conversationBinding.buildPluginBindingResolvedText);
    ({ registerSlackInteractionEvents } = await import("./interactions.js"));
  });

  beforeEach(() => {
    enqueueSystemEventSpy.mockClear();
    dispatchPluginInteractiveHandlerSpy.mockClear();
    resolvePluginConversationBindingApprovalSpy.mockClear();
    buildPluginBindingResolvedTextSpy.mockClear();
    enqueueSystemEventMock.mockClear();
    dispatchPluginInteractiveHandlerMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockResolvedValue({ status: "expired" });
    buildPluginBindingResolvedTextMock.mockClear();
    buildPluginBindingResolvedTextMock.mockReturnValue("Binding updated.");
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      duplicate: false,
      handled: false,
      matched: false,
    });
  });

  it("enqueues structured events and updates button rows", async () => {
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:verify",
        block_id: "verify_block",
        text: { text: "Approve", type: "plain_text" },
        type: "button",
        value: "approved",
      },
      body: {
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          blocks: [
            {
              block_id: "verify_block",
              elements: [{ type: "button", action_id: "openclaw:verify" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "100.200",
        },
        response_url: "https://hooks.slack.test/response",
        team: { id: "T9" },
        trigger_id: "123.trigger",
        user: { id: "U123" },
      },
      respond,
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    expect(eventText.startsWith("Slack interaction: ")).toBe(true);
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionId: string;
      actionType: string;
      value: string;
      userId: string;
      teamId?: string;
      triggerId?: string;
      responseUrl?: string;
      channelId: string;
      messageTs: string;
      threadTs?: string;
    };
    expect(payload).toMatchObject({
      actionId: "openclaw:verify",
      actionType: "button",
      channelId: "C1",
      messageTs: "100.200",
      responseUrl: "[redacted]",
      teamId: "T9",
      threadTs: "100.100",
      triggerId: "[redacted]",
      userId: "U123",
      value: "approved",
    });
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
    });
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("registers a matcher that accepts plugin action ids beyond the OpenClaw prefix", () => {
    const { ctx, getActionMatcher } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const matcher = getActionMatcher();
    expect(matcher).toBeTruthy();
    expect(matcher?.test("openclaw:verify")).toBe(true);
    expect(matcher?.test("codex")).toBe(true);
  });

  it("routes matching Slack actions through the shared plugin interactive dispatcher", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      duplicate: false,
      handled: true,
      matched: true,
    });
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "codex",
        block_id: "codex_actions",
        text: { text: "Approve", type: "plain_text" },
        type: "button",
        value: "approve:thread-1",
      },
      body: {
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          blocks: [
            {
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "100.200",
        },
        response_url: "https://hooks.slack.test/response",
        team: { id: "T9" },
        trigger_id: "123.trigger",
        user: { id: "U123" },
      },
      respond,
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCalls = dispatchPluginInteractiveHandlerMock.mock.calls as unknown[][];
    const dispatchCall = dispatchCalls[0]?.[0] as
      | {
          channel?: string;
          data?: string;
          dedupeId?: string;
          invoke?: (params: {
            registration: { handler: (ctx: unknown) => unknown };
            namespace: string;
            payload: string;
          }) => Promise<unknown>;
        }
      | undefined;
    expect(dispatchCall).toMatchObject({
      channel: "slack",
      data: "codex:approve:thread-1",
      dedupeId: "U123:C1:100.200:123.trigger:codex:approve:thread-1",
    });
    const registrationHandler = vi.fn();
    await dispatchCall?.invoke?.({
      namespace: "codex",
      payload: "approve:thread-1",
      registration: { handler: registrationHandler },
    });
    expect(registrationHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ctx.accountId,
        conversationId: "C1",
        interaction: expect.objectContaining({
          actionId: "codex",
          data: "codex:approve:thread-1",
          namespace: "codex",
          payload: "approve:thread-1",
          value: "approve:thread-1",
        }),
        interactionId: "U123:C1:100.200:123.trigger:codex:approve:thread-1",
        threadId: "100.100",
      }),
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("treats Slack reply buttons as plain interaction events instead of plugin dispatch", async () => {
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:reply_button",
        block_id: "reply_actions",
        text: { text: "codex", type: "plain_text" },
        type: "button",
        value: "codex",
      },
      body: {
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          blocks: [
            {
              block_id: "reply_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "100.200",
        },
        user: { id: "U123" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining('"actionId":"openclaw:reply_button"'),
      expect.any(Object),
    );
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("uses unique interaction ids for repeated Slack actions on the same message", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      duplicate: false,
      handled: false,
      matched: true,
    });
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "codex",
        block_id: "codex_actions",
        text: { text: "Approve", type: "plain_text" },
        type: "button",
        value: "approve:thread-1",
      },
      body: {
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          blocks: [
            {
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "100.200",
        },
        trigger_id: "trigger-1",
        user: { id: "U123" },
      },
    });
    await handler!({
      ack,
      action: {
        action_id: "codex",
        block_id: "codex_actions",
        text: { text: "Approve", type: "plain_text" },
        type: "button",
        value: "approve:thread-1",
      },
      body: {
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          blocks: [
            {
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "100.200",
        },
        trigger_id: "trigger-2",
        user: { id: "U123" },
      },
    });

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(2);
    const calls = dispatchPluginInteractiveHandlerMock.mock.calls as unknown[][];
    const firstCall = calls[0]?.[0] as
      | {
          dedupeId?: string;
        }
      | undefined;
    const secondCall = calls[1]?.[0] as
      | {
          dedupeId?: string;
        }
      | undefined;
    expect(firstCall?.dedupeId).toContain(":trigger-1:");
    expect(secondCall?.dedupeId).toContain(":trigger-2:");
    expect(firstCall?.dedupeId).not.toBe(secondCall?.dedupeId);
  });

  it("resolves plugin binding approvals from shared interactive Slack actions", async () => {
    resolvePluginConversationBindingApprovalMock.mockResolvedValueOnce({
      decision: "allow-once",
      request: {
        pluginId: "codex",
        pluginName: "Codex",
        summary: "for this thread",
      },
      status: "approved",
    });
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:reply_button",
        block_id: "bind_actions",
        text: { text: "Allow once", type: "plain_text" },
        type: "button",
        value: "pluginbind:approval-123:o",
      },
      body: {
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          blocks: [
            {
              block_id: "bind_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
              type: "actions",
            },
          ],
          text: "Approve this bind?",
          ts: "100.200",
        },
        user: { id: "U123" },
      },
      respond,
    });

    expect(ack).toHaveBeenCalled();
    expect(resolvePluginConversationBindingApprovalMock).toHaveBeenCalledWith({
      approvalId: "approval-123",
      decision: "allow-once",
      senderId: "U123",
    });
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [],
        channel: "C1",
        text: "Approve this bind?",
        ts: "100.200",
      }),
    );
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: "Binding updated.",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("drops block actions when mismatch guard triggers", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      shouldDropMismatchedSlackEvent: () => true,
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:verify",
        type: "button",
      },
      body: {
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          blocks: [],
          text: "fallback",
          ts: "100.200",
        },
        team: { id: "T9" },
        user: { id: "U123" },
      },
      respond,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("drops modal lifecycle payloads when mismatch guard triggers", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler, getViewClosedHandler } = createContext({
      shouldDropMismatchedSlackEvent: () => true,
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const viewHandler = getViewHandler();
    const viewClosedHandler = getViewClosedHandler();
    expect(viewHandler).toBeTruthy();
    expect(viewClosedHandler).toBeTruthy();

    const ackSubmit = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack: ackSubmit,
      body: {
        team: { id: "T9" },
        user: { id: "U123" },
        view: {
          callback_id: "openclaw:deploy_form",
          id: "V123",
          private_metadata: JSON.stringify({ userId: "U123" }),
        },
      },
    });
    expect(ackSubmit).toHaveBeenCalledTimes(1);

    const ackClosed = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler!({
      ack: ackClosed,
      body: {
        team: { id: "T9" },
        user: { id: "U123" },
        view: {
          callback_id: "openclaw:deploy_form",
          id: "V123",
          private_metadata: JSON.stringify({ userId: "U123" }),
        },
      },
    });
    expect(ackClosed).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("captures select values and updates action rows for non-button actions", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:pick",
        block_id: "select_block",
        selected_option: {
          text: { text: "Canary", type: "plain_text" },
          value: "canary",
        },
        type: "static_select",
      },
      body: {
        channel: { id: "C1" },
        message: {
          blocks: [{ block_id: "select_block", elements: [], type: "actions" }],
          ts: "111.222",
        },
        user: { id: "U555" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType: string;
      selectedValues?: string[];
      selectedLabels?: string[];
    };
    expect(payload.actionType).toBe("static_select");
    expect(payload.selectedValues).toEqual(["canary"]);
    expect(payload.selectedLabels).toEqual(["Canary"]);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          {
            elements: [{ type: "mrkdwn", text: ":white_check_mark: *Canary* selected by <@U555>" }],
            type: "context",
          },
        ],
        channel: "C1",
        ts: "111.222",
      }),
    );
  });

  it("blocks block actions from users outside configured channel users allowlist", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      channelsConfig: {
        C1: { users: ["U_ALLOWED"] },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:verify",
        block_id: "verify_block",
        type: "button",
      },
      body: {
        channel: { id: "C1" },
        message: {
          blocks: [{ block_id: "verify_block", elements: [], type: "actions" }],
          ts: "201.202",
        },
        user: { id: "U_DENIED" },
      },
      respond,
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: "You are not authorized to use this control.",
    });
  });

  it("blocks DM block actions when sender is not in allowFrom", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      allowFrom: ["U_OWNER"],
      dmPolicy: "allowlist",
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:verify",
        block_id: "verify_block",
        type: "button",
      },
      body: {
        channel: { id: "D222" },
        message: {
          blocks: [{ block_id: "verify_block", elements: [], type: "actions" }],
          ts: "301.302",
        },
        user: { id: "U_ATTACKER" },
      },
      respond,
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: "You are not authorized to use this control.",
    });
  });

  it("ignores malformed action payloads after ack and logs warning", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler, runtimeLog } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: "not-an-action-object" as unknown as Record<string, unknown>,
      body: {
        channel: { id: "C1" },
        message: {
          blocks: [
            {
              block_id: "verify_block",
              elements: [{ type: "button", action_id: "openclaw:verify" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "777.888",
        },
        user: { id: "U666" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("slack:interaction malformed"));
  });

  it("escapes mrkdwn characters in confirmation labels", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:pick",
        block_id: "select_block",
        selected_option: {
          text: { text: "Canary_*`~<&>", type: "plain_text" },
          value: "canary",
        },
        type: "static_select",
      },
      body: {
        channel: { id: "C1" },
        message: {
          blocks: [{ block_id: "select_block", elements: [], type: "actions" }],
          ts: "111.223",
        },
        user: { id: "U556" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          {
            elements: [
              {
                type: "mrkdwn",
                text: ":white_check_mark: *Canary\\_\\*\\`\\~&lt;&amp;&gt;* selected by <@U556>",
              },
            ],
            type: "context",
          },
        ],
        channel: "C1",
        ts: "111.223",
      }),
    );
  });

  it("falls back to container channel and message timestamps", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:container",
        block_id: "container_block",
        text: { text: "Container", type: "plain_text" },
        type: "button",
        value: "ok",
      },
      body: {
        container: { channel_id: "C222", message_ts: "222.333", thread_ts: "222.111" },
        team: { id: "T111" },
        user: { id: "U111" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C222",
      channelType: "channel",
      senderId: "U111",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      channelId?: string;
      messageTs?: string;
      threadTs?: string;
      teamId?: string;
    };
    expect(payload).toMatchObject({
      channelId: "C222",
      messageTs: "222.333",
      teamId: "T111",
      threadTs: "222.111",
    });
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("summarizes multi-select confirmations in updated message rows", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:multi",
        block_id: "multi_block",
        selected_options: [
          { text: { text: "Alpha", type: "plain_text" }, value: "alpha" },
          { text: { text: "Beta", type: "plain_text" }, value: "beta" },
          { text: { text: "Gamma", type: "plain_text" }, value: "gamma" },
          { text: { text: "Delta", type: "plain_text" }, value: "delta" },
        ],
        type: "multi_static_select",
      },
      body: {
        channel: { id: "C2" },
        message: {
          blocks: [
            {
              block_id: "multi_block",
              elements: [{ type: "multi_static_select", action_id: "openclaw:multi" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "333.444",
        },
        user: { id: "U222" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          {
            elements: [
              {
                type: "mrkdwn",
                text: ":white_check_mark: *Alpha, Beta, Gamma +1* selected by <@U222>",
              },
            ],
            type: "context",
          },
        ],
        channel: "C2",
        ts: "333.444",
      }),
    );
  });

  it("renders date/time/datetime picker selections in confirmation rows", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:date",
        block_id: "date_block",
        selected_date: "2026-02-16",
        type: "datepicker",
      },
      body: {
        channel: { id: "C3" },
        message: {
          blocks: [
            {
              block_id: "date_block",
              elements: [{ type: "datepicker", action_id: "openclaw:date" }],
              type: "actions",
            },
            {
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
              type: "actions",
            },
            {
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "555.666",
        },
        user: { id: "U333" },
      },
    });

    await handler!({
      ack,
      action: {
        action_id: "openclaw:time",
        block_id: "time_block",
        selected_time: "14:30",
        type: "timepicker",
      },
      body: {
        channel: { id: "C3" },
        message: {
          blocks: [
            {
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "555.667",
        },
        user: { id: "U333" },
      },
    });

    await handler!({
      ack,
      action: {
        action_id: "openclaw:datetime",
        block_id: "datetime_block",
        selected_date_time: selectedDateTimeEpoch,
        type: "datetimepicker",
      },
      body: {
        channel: { id: "C3" },
        message: {
          blocks: [
            {
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
              type: "actions",
            },
          ],
          text: "fallback",
          ts: "555.668",
        },
        user: { id: "U333" },
      },
    });

    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        blocks: [
          {
            elements: [
              { type: "mrkdwn", text: ":white_check_mark: *2026-02-16* selected by <@U333>" },
            ],
            type: "context",
          },
          expect.anything(),
          expect.anything(),
        ],
        channel: "C3",
        ts: "555.666",
      }),
    );
    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        blocks: [
          {
            elements: [{ type: "mrkdwn", text: ":white_check_mark: *14:30* selected by <@U333>" }],
            type: "context",
          },
        ],
        channel: "C3",
        ts: "555.667",
      }),
    );
    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        blocks: [
          {
            elements: [
              {
                type: "mrkdwn",
                text: `:white_check_mark: *${new Date(
                  selectedDateTimeEpoch * 1000,
                ).toISOString()}* selected by <@U333>`,
              },
            ],
            type: "context",
          },
        ],
        channel: "C3",
        ts: "555.668",
      }),
    );
  });

  it("captures expanded selection and temporal payload fields", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:route",
        selected_channel: "C777",
        selected_channels: ["C777", "C888"],
        selected_conversation: "G777",
        selected_conversations: ["G777", "G888"],
        selected_date: "2026-02-16",
        selected_date_time: 1_771_700_200,
        selected_options: [
          { text: { text: "Alpha", type: "plain_text" }, value: "alpha" },
          { text: { text: "Alpha", type: "plain_text" }, value: "alpha" },
          { text: { text: "Beta", type: "plain_text" }, value: "beta" },
        ],
        selected_time: "14:30",
        selected_user: "U777",
        selected_users: ["U777", "U888"],
        type: "multi_conversations_select",
      },
      body: {
        channel: { id: "C2" },
        message: { ts: "222.333" },
        user: { id: "U321" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType: string;
      selectedValues?: string[];
      selectedUsers?: string[];
      selectedChannels?: string[];
      selectedConversations?: string[];
      selectedLabels?: string[];
      selectedDate?: string;
      selectedTime?: string;
      selectedDateTime?: number;
    };
    expect(payload.actionType).toBe("multi_conversations_select");
    expect(payload.selectedValues).toEqual([
      "alpha",
      "beta",
      "U777",
      "U888",
      "C777",
      "C888",
      "G777",
      "G888",
    ]);
    expect(payload.selectedUsers).toEqual(["U777", "U888"]);
    expect(payload.selectedChannels).toEqual(["C777", "C888"]);
    expect(payload.selectedConversations).toEqual(["G777", "G888"]);
    expect(payload.selectedLabels).toEqual(["Alpha", "Beta"]);
    expect(payload.selectedDate).toBe("2026-02-16");
    expect(payload.selectedTime).toBe("14:30");
    expect(payload.selectedDateTime).toBe(1_771_700_200);
  });

  it("captures workflow button trigger metadata", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      action: {
        action_id: "openclaw:workflow",
        block_id: "workflow_block",
        text: { text: "Launch workflow", type: "plain_text" },
        type: "workflow_button",
        workflow: {
          trigger_url: "https://slack.com/workflows/triggers/T420/12345",
          workflow_id: "Wf12345",
        },
      },
      body: {
        channel: { id: "C420" },
        message: { ts: "420.420" },
        team: { id: "T420" },
        user: { id: "U420" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType?: string;
      workflowTriggerUrl?: string;
      workflowId?: string;
      teamId?: string;
      channelId?: string;
    };
    expect(payload).toMatchObject({
      actionType: "workflow_button",
      channelId: "C420",
      teamId: "T420",
      workflowId: "Wf12345",
      workflowTriggerUrl: "[redacted]",
    });
  });

  it("captures modal submissions and enqueues view submission event", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        team: { id: "T1" },
        user: { id: "U777" },
        view: {
          callback_id: "openclaw:deploy_form",
          external_id: "deploy-ext-1",
          hash: "view-hash-1",
          id: "V123",
          previous_view_id: "VPREV",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
            userId: "U777",
          }),
          root_view_id: "VROOT",
          state: {
            values: {
              env_block: {
                env_select: {
                  selected_option: {
                    text: { text: "Production", type: "plain_text" },
                    value: "prod",
                  },
                  type: "static_select",
                },
              },
              notes_block: {
                notes_input: {
                  type: "plain_text_input",
                  value: "ship now",
                },
              },
            },
          },
        } as unknown as {
          id?: string;
          callback_id?: string;
          root_view_id?: string;
          previous_view_id?: string;
          external_id?: string;
          hash?: string;
          state?: { values: Record<string, unknown> };
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      actionId: string;
      callbackId: string;
      viewId: string;
      userId: string;
      routedChannelId?: string;
      rootViewId?: string;
      previousViewId?: string;
      externalId?: string;
      viewHash?: string;
      isStackedView?: boolean;
      inputs: { actionId: string; selectedValues?: string[]; inputValue?: string }[];
    };
    expect(payload).toMatchObject({
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      externalId: "deploy-ext-1",
      interactionType: "view_submission",
      isStackedView: true,
      previousViewId: "VPREV",
      rootViewId: "VROOT",
      routedChannelId: "D123",
      userId: "U777",
      viewHash: "[redacted]",
      viewId: "V123",
    });
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: "env_select", selectedValues: ["prod"] }),
        expect.objectContaining({ actionId: "notes_input", inputValue: "ship now" }),
      ]),
    );
  });

  it("blocks modal events when private metadata userId does not match submitter", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        user: { id: "U222" },
        view: {
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
            userId: "U111",
          }),
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks modal events when private metadata is missing userId", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        user: { id: "U222" },
        view: {
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
          }),
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("captures modal input labels and picker values across block types", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        user: { id: "U444" },
        view: {
          callback_id: "openclaw:routing_form",
          id: "V400",
          private_metadata: JSON.stringify({ userId: "U444" }),
          state: {
            values: {
              assignee_block: {
                assignee_select: {
                  selected_user: "U900",
                  type: "users_select",
                },
              },
              channel_block: {
                channel_select: {
                  selected_channel: "C900",
                  type: "channels_select",
                },
              },
              checks_block: {
                checks_select: {
                  selected_options: [
                    { text: { text: "A", type: "plain_text" }, value: "a" },
                    { text: { text: "B", type: "plain_text" }, value: "b" },
                  ],
                  type: "checkboxes",
                },
              },
              convo_block: {
                convo_select: {
                  selected_conversation: "G900",
                  type: "conversations_select",
                },
              },
              date_block: {
                date_select: {
                  selected_date: "2026-02-16",
                  type: "datepicker",
                },
              },
              datetime_block: {
                datetime_select: {
                  selected_date_time: 1_771_632_300,
                  type: "datetimepicker",
                },
              },
              email_block: {
                email_input: {
                  type: "email_text_input",
                  value: "team@openclaw.ai",
                },
              },
              env_block: {
                env_select: {
                  selected_option: {
                    text: { text: "Production", type: "plain_text" },
                    value: "prod",
                  },
                  type: "static_select",
                },
              },
              number_block: {
                number_input: {
                  type: "number_input",
                  value: "42.5",
                },
              },
              radio_block: {
                radio_select: {
                  selected_option: {
                    text: { text: "Blue", type: "plain_text" },
                    value: "blue",
                  },
                  type: "radio_buttons",
                },
              },
              richtext_block: {
                richtext_input: {
                  rich_text_value: {
                    elements: [
                      {
                        elements: [
                          { type: "text", text: "Ship this now" },
                          { type: "text", text: "with canary metrics" },
                        ],
                        type: "rich_text_section",
                      },
                    ],
                    type: "rich_text",
                  },
                  type: "rich_text_input",
                },
              },
              time_block: {
                time_select: {
                  selected_time: "12:45",
                  type: "timepicker",
                },
              },
              url_block: {
                url_input: {
                  type: "url_text_input",
                  value: "https://docs.openclaw.ai",
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      inputs: {
        actionId: string;
        inputKind?: string;
        selectedValues?: string[];
        selectedUsers?: string[];
        selectedChannels?: string[];
        selectedConversations?: string[];
        selectedLabels?: string[];
        selectedDate?: string;
        selectedTime?: string;
        selectedDateTime?: number;
        inputNumber?: number;
        inputEmail?: string;
        inputUrl?: string;
        richTextValue?: unknown;
        richTextPreview?: string;
      }[];
    };
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "env_select",
          selectedLabels: ["Production"],
          selectedValues: ["prod"],
        }),
        expect.objectContaining({
          actionId: "assignee_select",
          selectedUsers: ["U900"],
          selectedValues: ["U900"],
        }),
        expect.objectContaining({
          actionId: "channel_select",
          selectedChannels: ["C900"],
          selectedValues: ["C900"],
        }),
        expect.objectContaining({
          actionId: "convo_select",
          selectedConversations: ["G900"],
          selectedValues: ["G900"],
        }),
        expect.objectContaining({ actionId: "date_select", selectedDate: "2026-02-16" }),
        expect.objectContaining({ actionId: "time_select", selectedTime: "12:45" }),
        expect.objectContaining({ actionId: "datetime_select", selectedDateTime: 1_771_632_300 }),
        expect.objectContaining({
          actionId: "radio_select",
          selectedLabels: ["Blue"],
          selectedValues: ["blue"],
        }),
        expect.objectContaining({
          actionId: "checks_select",
          selectedLabels: ["A", "B"],
          selectedValues: ["a", "b"],
        }),
        expect.objectContaining({
          actionId: "number_input",
          inputKind: "number",
          inputNumber: 42.5,
        }),
        expect.objectContaining({
          actionId: "email_input",
          inputEmail: "team@openclaw.ai",
          inputKind: "email",
        }),
        expect.objectContaining({
          actionId: "url_input",
          inputKind: "url",
          inputUrl: "https://docs.openclaw.ai/",
        }),
        expect.objectContaining({
          actionId: "richtext_input",
          inputKind: "rich_text",
          richTextPreview: "Ship this now with canary metrics",
          richTextValue: {
            elements: [
              {
                elements: [
                  { type: "text", text: "Ship this now" },
                  { type: "text", text: "with canary metrics" },
                ],
                type: "rich_text_section",
              },
            ],
            type: "rich_text",
          },
        }),
      ]),
    );
  });

  it("truncates rich text preview to keep payload summaries compact", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const longText = "deploy ".repeat(40).trim();
    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        user: { id: "U555" },
        view: {
          callback_id: "openclaw:long_richtext",
          id: "V555",
          private_metadata: JSON.stringify({ userId: "U555" }),
          state: {
            values: {
              richtext_block: {
                richtext_input: {
                  rich_text_value: {
                    elements: [
                      {
                        elements: [{ type: "text", text: longText }],
                        type: "rich_text_section",
                      },
                    ],
                    type: "rich_text",
                  },
                  type: "rich_text_input",
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      inputs: { actionId: string; richTextPreview?: string }[];
    };
    const richInput = payload.inputs.find((input) => input.actionId === "richtext_input");
    expect(richInput?.richTextPreview).toBeTruthy();
    expect((richInput?.richTextPreview ?? "").length).toBeLessThanOrEqual(120);
  });

  it("captures modal close events and enqueues view closed event", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewClosedHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewClosedHandler = getViewClosedHandler();
    expect(viewClosedHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler!({
      ack,
      body: {
        is_cleared: true,
        team: { id: "T1" },
        user: { id: "U900" },
        view: {
          callback_id: "openclaw:deploy_form",
          external_id: "deploy-ext-900",
          hash: "view-hash-900",
          id: "V900",
          previous_view_id: "VPREV900",
          private_metadata: JSON.stringify({
            sessionKey: "agent:main:slack:channel:C99",
            userId: "U900",
          }),
          root_view_id: "VROOT900",
          state: {
            values: {
              env_block: {
                env_select: {
                  selected_option: {
                    text: { text: "Canary", type: "plain_text" },
                    value: "canary",
                  },
                  type: "static_select",
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText, options] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey?: string },
    ];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      actionId: string;
      callbackId: string;
      viewId: string;
      userId: string;
      isCleared: boolean;
      privateMetadata: string;
      rootViewId?: string;
      previousViewId?: string;
      externalId?: string;
      viewHash?: string;
      isStackedView?: boolean;
      inputs: { actionId: string; selectedValues?: string[] }[];
    };
    expect(payload).toMatchObject({
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      externalId: "deploy-ext-900",
      interactionType: "view_closed",
      isCleared: true,
      isStackedView: true,
      previousViewId: "VPREV900",
      privateMetadata: "[redacted]",
      rootViewId: "VROOT900",
      userId: "U900",
      viewHash: "[redacted]",
      viewId: "V900",
    });
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: "env_select", selectedValues: ["canary"] }),
      ]),
    );
    expect(options.sessionKey).toBe("agent:main:slack:channel:C99");
  });

  it("defaults modal close isCleared to false when Slack omits the flag", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewClosedHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewClosedHandler = getViewClosedHandler();
    expect(viewClosedHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler!({
      ack,
      body: {
        user: { id: "U901" },
        view: {
          callback_id: "openclaw:deploy_form",
          id: "V901",
          private_metadata: JSON.stringify({ userId: "U901" }),
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      isCleared?: boolean;
    };
    expect(payload.interactionType).toBe("view_closed");
    expect(payload.isCleared).toBe(false);
  });

  it("caps oversized interaction payloads with compact summaries", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const richTextValue = {
      elements: Array.from({ length: 20 }, (_, index) => ({
        elements: [{ type: "text", text: `chunk-${index}-${"x".repeat(400)}` }],
        type: "rich_text_section",
      })),
      type: "rich_text",
    };
    const values: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 20; index += 1) {
      values[`block_${index}`] = {
        [`input_${index}`]: {
          rich_text_value: richTextValue,
          type: "rich_text_input",
        },
      };
    }

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        team: { id: "T1" },
        user: { id: "U915" },
        view: {
          callback_id: "openclaw:oversize",
          id: "V915",
          private_metadata: JSON.stringify({
            channelId: "D915",
            channelType: "im",
            userId: "U915",
          }),
          state: {
            values,
          },
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    expect(eventText.length).toBeLessThanOrEqual(2400);
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      payloadTruncated?: boolean;
      inputs?: unknown[];
      inputsOmitted?: number;
    };
    expect(payload.payloadTruncated).toBe(true);
    expect(Array.isArray(payload.inputs) ? payload.inputs.length : 0).toBeLessThanOrEqual(3);
    expect((payload.inputsOmitted ?? 0) >= 1).toBe(true);
  });
});
const selectedDateTimeEpoch = 1_771_632_300;
