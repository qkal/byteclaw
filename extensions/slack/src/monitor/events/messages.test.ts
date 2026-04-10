import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SlackSystemEventTestOverrides,
  createSlackSystemEventTestHarness,
} from "./system-event-test-harness.js";

const messageQueueMock = vi.fn();
const messageAllowMock = vi.fn();

async function createChannelRuntimeMock() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => messageQueueMock(...args),
  };
}

vi.mock("openclaw/plugin-sdk/infra-runtime", createChannelRuntimeMock);
vi.mock("openclaw/plugin-sdk/infra-runtime.js", createChannelRuntimeMock);

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => messageAllowMock(...args),
  };
});

let registerSlackMessageEvents: typeof import("./messages.js").registerSlackMessageEvents;

type MessageHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;
type RegisteredEventName = "message" | "app_mention";

interface MessageCase {
  overrides?: SlackSystemEventTestOverrides;
  event?: Record<string, unknown>;
  body?: unknown;
}

function createHandlers(eventName: RegisteredEventName, overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  const handleSlackMessage = vi.fn(async () => {});
  registerSlackMessageEvents({
    ctx: harness.ctx,
    handleSlackMessage,
  });
  return {
    handleSlackMessage,
    handler: harness.getHandler(eventName) as MessageHandler | null,
  };
}

function resetMessageMocks(): void {
  messageQueueMock.mockClear();
  messageAllowMock.mockReset().mockResolvedValue([]);
}

beforeAll(async () => {
  ({ registerSlackMessageEvents } = await import("./messages.js"));
});

beforeEach(() => {
  resetMessageMocks();
});

function makeChangedEvent(overrides?: { channel?: string; user?: string }) {
  const user = overrides?.user ?? "U1";
  return {
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
    message: { ts: "123.456", user },
    previous_message: { ts: "123.450", user },
    subtype: "message_changed",
    type: "message",
  };
}

function makeDeletedEvent(overrides?: { channel?: string; user?: string }) {
  return {
    channel: overrides?.channel ?? "D1",
    deleted_ts: "123.456",
    event_ts: "123.456",
    previous_message: {
      ts: "123.450",
      user: overrides?.user ?? "U1",
    },
    subtype: "message_deleted",
    type: "message",
  };
}

function makeThreadBroadcastEvent(overrides?: { channel?: string; user?: string }) {
  const user = overrides?.user ?? "U1";
  return {
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
    message: { ts: "123.456", user },
    subtype: "thread_broadcast",
    type: "message",
    user,
  };
}

function makeAppMentionEvent(overrides?: {
  channel?: string;
  channelType?: "channel" | "group" | "im" | "mpim";
  ts?: string;
}) {
  return {
    channel: overrides?.channel ?? "C123",
    channel_type: overrides?.channelType ?? "channel",
    text: "<@U_BOT> hello",
    ts: overrides?.ts ?? "123.456",
    type: "app_mention",
    user: "U1",
  };
}

async function invokeRegisteredHandler(input: {
  eventName: RegisteredEventName;
  overrides?: SlackSystemEventTestOverrides;
  event: Record<string, unknown>;
  body?: unknown;
}) {
  const { handler, handleSlackMessage } = createHandlers(input.eventName, input.overrides);
  expect(handler).toBeTruthy();
  await handler!({
    body: input.body ?? {},
    event: input.event,
  });
  return { handleSlackMessage };
}

async function runMessageCase(input: MessageCase = {}): Promise<void> {
  const { handler } = createHandlers("message", input.overrides);
  expect(handler).toBeTruthy();
  await handler!({
    body: input.body ?? {},
    event: (input.event ?? makeChangedEvent()) as Record<string, unknown>,
  });
}

describe("registerSlackMessageEvents", () => {
  const cases: { name: string; input: MessageCase; calls: number }[] = [
    {
      calls: 1,
      input: { event: makeChangedEvent(), overrides: { dmPolicy: "open" } },
      name: "enqueues message_changed system events when dmPolicy is open",
    },
    {
      calls: 0,
      input: { event: makeChangedEvent(), overrides: { dmPolicy: "disabled" } },
      name: "blocks message_changed system events when dmPolicy is disabled",
    },
    {
      calls: 0,
      input: {
        event: makeChangedEvent({ user: "U1" }),
        overrides: { allowFrom: ["U2"], dmPolicy: "allowlist" },
      },
      name: "blocks message_changed system events for unauthorized senders in allowlist mode",
    },
    {
      calls: 0,
      input: {
        event: makeDeletedEvent({ channel: "C1", user: "U_ATTACKER" }),
        overrides: {
          channelType: "channel",
          channelUsers: ["U_OWNER"],
          dmPolicy: "open",
        },
      },
      name: "blocks message_deleted system events for users outside channel users allowlist",
    },
    {
      calls: 0,
      input: {
        event: {
          ...makeThreadBroadcastEvent(),
          message: { ts: "123.456" },
          user: undefined,
        },
        overrides: { dmPolicy: "open" },
      },
      name: "blocks thread_broadcast system events without an authenticated sender",
    },
  ];
  it.each(cases)("$name", async ({ input, calls }) => {
    await runMessageCase(input);
    expect(messageQueueMock).toHaveBeenCalledTimes(calls);
  });

  it("passes regular message events to the message handler", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      event: {
        channel: "D1",
        text: "hello",
        ts: "123.456",
        type: "message",
        user: "U1",
      },
      eventName: "message",
      overrides: { dmPolicy: "open" },
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("handles channel and group messages via the unified message handler", async () => {
    const { handler, handleSlackMessage } = createHandlers("message", {
      channelType: "channel",
      dmPolicy: "open",
    });

    expect(handler).toBeTruthy();

    // Channel_type distinguishes the source; all arrive as event type "message"
    const channelMessage = {
      channel: "C1",
      channel_type: "channel",
      text: "hello channel",
      ts: "123.100",
      type: "message",
      user: "U1",
    };
    await handler!({ body: {}, event: channelMessage });
    await handler!({
      body: {},
      event: {
        ...channelMessage,
        channel: "G1",
        channel_type: "group",
        ts: "123.200",
      },
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(2);
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("applies subtype system-event handling for channel messages", async () => {
    // Message_changed events from channels arrive via the generic "message"
    // Handler with channel_type:"channel" — not a separate event type.
    const { handleSlackMessage } = await invokeRegisteredHandler({
      event: {
        ...makeChangedEvent({ channel: "C1", user: "U1" }),
        channel_type: "channel",
      },
      eventName: "message",
      overrides: {
        channelType: "channel",
        dmPolicy: "open",
      },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).toHaveBeenCalledTimes(1);
  });

  it("skips app_mention events for DM channel ids even with contradictory channel_type", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      event: makeAppMentionEvent({ channel: "D123", channelType: "channel" }),
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
  });

  it("routes app_mention events from channels to the message handler", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      event: makeAppMentionEvent({ channel: "C123", channelType: "channel", ts: "123.789" }),
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
  });
});
