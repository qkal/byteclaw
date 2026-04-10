import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const reactionQueueMock = vi.hoisted(() => vi.fn());
let registerSlackReactionEvents: typeof import("./reactions.js").registerSlackReactionEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type SlackSystemEventTestOverrides =
  import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

async function createChannelRuntimeMock() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => reactionQueueMock(...args),
  };
}

vi.mock("openclaw/plugin-sdk/infra-runtime", createChannelRuntimeMock);
vi.mock("openclaw/plugin-sdk/infra-runtime.js", createChannelRuntimeMock);

type ReactionHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

interface ReactionRunInput {
  handler?: "added" | "removed";
  overrides?: SlackSystemEventTestOverrides;
  event?: Record<string, unknown>;
  body?: unknown;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}

function buildReactionEvent(overrides?: { user?: string; channel?: string }) {
  return {
    item: {
      channel: overrides?.channel ?? "D1",
      ts: "123.456",
      type: "message",
    },
    item_user: "UBOT",
    reaction: "thumbsup",
    type: "reaction_added",
    user: overrides?.user ?? "U1",
  };
}

function createReactionHandlers(params: {
  overrides?: SlackSystemEventTestOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackReactionEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    added: harness.getHandler("reaction_added") as ReactionHandler | null,
    removed: harness.getHandler("reaction_removed") as ReactionHandler | null,
  };
}

async function executeReactionCase(input: ReactionRunInput = {}) {
  reactionQueueMock.mockClear();
  const handlers = createReactionHandlers({
    overrides: input.overrides,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent,
    trackEvent: input.trackEvent,
  });
  const handler = handlers[input.handler ?? "added"];
  expect(handler).toBeTruthy();
  await handler!({
    body: input.body ?? {},
    event: (input.event ?? buildReactionEvent()) as Record<string, unknown>,
  });
}

describe("registerSlackReactionEvents", () => {
  beforeAll(async () => {
    ({ registerSlackReactionEvents } = await import("./reactions.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    reactionQueueMock.mockClear();
  });

  const cases: { name: string; input: ReactionRunInput; expectedCalls: number }[] = [
    {
      expectedCalls: 1,
      input: { overrides: { dmPolicy: "open" } },
      name: "enqueues DM reaction system events when dmPolicy is open",
    },
    {
      expectedCalls: 0,
      input: { overrides: { dmPolicy: "disabled" } },
      name: "blocks DM reaction system events when dmPolicy is disabled",
    },
    {
      expectedCalls: 0,
      input: {
        event: buildReactionEvent({ user: "U1" }),
        overrides: { allowFrom: ["U2"], dmPolicy: "allowlist" },
      },
      name: "blocks DM reaction system events for unauthorized senders in allowlist mode",
    },
    {
      expectedCalls: 1,
      input: {
        event: buildReactionEvent({ user: "U1" }),
        overrides: { allowFrom: ["U1"], dmPolicy: "allowlist" },
      },
      name: "allows DM reaction system events for authorized senders in allowlist mode",
    },
    {
      expectedCalls: 1,
      input: {
        event: {
          ...buildReactionEvent({ channel: "C1" }),
          type: "reaction_removed",
        },
        handler: "removed",
        overrides: { channelType: "channel", dmPolicy: "disabled" },
      },
      name: "enqueues channel reaction events regardless of dmPolicy",
    },
    {
      expectedCalls: 0,
      input: {
        event: buildReactionEvent({ channel: "C1", user: "U_ATTACKER" }),
        overrides: {
          channelType: "channel",
          channelUsers: ["U_OWNER"],
          dmPolicy: "open",
        },
      },
      name: "blocks channel reaction events for users outside channel users allowlist",
    },
  ];

  it.each(cases)("$name", async ({ input, expectedCalls }) => {
    await executeReactionCase(input);
    expect(reactionQueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({
      body: { api_app_id: "A_OTHER" },
      shouldDropMismatchedSlackEvent: () => true,
      trackEvent,
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted message reactions", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("passes sender context when resolving reaction session keys", async () => {
    reactionQueueMock.mockClear();
    const harness = createSlackSystemEventTestHarness();
    const resolveSessionKey = vi.fn().mockReturnValue("agent:ops:main");
    harness.ctx.resolveSlackSystemEventSessionKey = resolveSessionKey;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("reaction_added");
    expect(handler).toBeTruthy();

    await handler!({
      body: {},
      event: buildReactionEvent({ channel: "D123", user: "U777" }),
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777",
    });
  });
});
