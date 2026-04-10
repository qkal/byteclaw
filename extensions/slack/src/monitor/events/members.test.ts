import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
}));
let registerSlackMemberEvents: typeof import("./members.js").registerSlackMemberEvents;
let initSlackHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type MemberOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

async function createChannelRuntimeMock() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return { ...actual, enqueueSystemEvent: memberMocks.enqueue };
}

vi.mock("openclaw/plugin-sdk/infra-runtime", createChannelRuntimeMock);
vi.mock("openclaw/plugin-sdk/infra-runtime.js", createChannelRuntimeMock);

type MemberHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

interface MemberCaseArgs {
  event?: Record<string, unknown>;
  body?: unknown;
  overrides?: MemberOverrides;
  handler?: "joined" | "left";
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}

function makeMemberEvent(overrides?: { channel?: string; user?: string }) {
  return {
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
    type: "member_joined_channel",
    user: overrides?.user ?? "U1",
  };
}

function getMemberHandlers(params: {
  overrides?: MemberOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = initSlackHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackMemberEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    joined: harness.getHandler("member_joined_channel") as MemberHandler | null,
    left: harness.getHandler("member_left_channel") as MemberHandler | null,
  };
}

async function runMemberCase(args: MemberCaseArgs = {}): Promise<void> {
  memberMocks.enqueue.mockClear();
  const handlers = getMemberHandlers({
    overrides: args.overrides,
    shouldDropMismatchedSlackEvent: args.shouldDropMismatchedSlackEvent,
    trackEvent: args.trackEvent,
  });
  const key = args.handler ?? "joined";
  const handler = handlers[key];
  expect(handler).toBeTruthy();
  await handler!({
    body: args.body ?? {},
    event: (args.event ?? makeMemberEvent()) as Record<string, unknown>,
  });
}

describe("registerSlackMemberEvents", () => {
  beforeAll(async () => {
    ({ registerSlackMemberEvents } = await import("./members.js"));
    ({ createSlackSystemEventTestHarness: initSlackHarness } =
      await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    memberMocks.enqueue.mockClear();
  });

  const cases: { name: string; args: MemberCaseArgs; calls: number }[] = [
    {
      args: { overrides: { dmPolicy: "open" } },
      calls: 1,
      name: "enqueues DM member events when dmPolicy is open",
    },
    {
      args: { overrides: { dmPolicy: "disabled" } },
      calls: 0,
      name: "blocks DM member events when dmPolicy is disabled",
    },
    {
      args: {
        event: makeMemberEvent({ user: "U1" }),
        overrides: { allowFrom: ["U2"], dmPolicy: "allowlist" },
      },
      calls: 0,
      name: "blocks DM member events for unauthorized senders in allowlist mode",
    },
    {
      args: {
        event: { ...makeMemberEvent({ user: "U1" }), type: "member_left_channel" },
        handler: "left" as const,
        overrides: { allowFrom: ["U1"], dmPolicy: "allowlist" },
      },
      calls: 1,
      name: "allows DM member events for authorized senders in allowlist mode",
    },
    {
      args: {
        event: makeMemberEvent({ channel: "C1", user: "U_ATTACKER" }),
        overrides: {
          channelType: "channel",
          channelUsers: ["U_OWNER"],
          dmPolicy: "open",
        },
      },
      calls: 0,
      name: "blocks channel member events for users outside channel users allowlist",
    },
  ];
  it.each(cases)("$name", async ({ args, calls }) => {
    await runMemberCase(args);
    expect(memberMocks.enqueue).toHaveBeenCalledTimes(calls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await runMemberCase({
      body: { api_app_id: "A_OTHER" },
      shouldDropMismatchedSlackEvent: () => true,
      trackEvent,
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted member events", async () => {
    const trackEvent = vi.fn();
    await runMemberCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
