import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pinEnqueueMock = vi.hoisted(() => vi.fn());
let registerSlackPinEvents: typeof import("./pins.js").registerSlackPinEvents;
let buildPinHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type PinOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

async function createChannelRuntimeMock() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return { ...actual, enqueueSystemEvent: pinEnqueueMock };
}

vi.mock("openclaw/plugin-sdk/infra-runtime", createChannelRuntimeMock);
vi.mock("openclaw/plugin-sdk/infra-runtime.js", createChannelRuntimeMock);

type PinHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

interface PinCase {
  body?: unknown;
  event?: Record<string, unknown>;
  handler?: "added" | "removed";
  overrides?: PinOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}

function makePinEvent(overrides?: { channel?: string; user?: string }) {
  return {
    channel_id: overrides?.channel ?? "D1",
    event_ts: "123.456",
    item: {
      message: { ts: "123.456" },
      type: "message",
    },
    type: "pin_added",
    user: overrides?.user ?? "U1",
  };
}

function installPinHandlers(args: {
  overrides?: PinOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = buildPinHarness(args.overrides);
  if (args.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = args.shouldDropMismatchedSlackEvent;
  }
  registerSlackPinEvents({ ctx: harness.ctx, trackEvent: args.trackEvent });
  return {
    added: harness.getHandler("pin_added") as PinHandler | null,
    removed: harness.getHandler("pin_removed") as PinHandler | null,
  };
}

async function runPinCase(input: PinCase = {}): Promise<void> {
  pinEnqueueMock.mockClear();
  const { added, removed } = installPinHandlers({
    overrides: input.overrides,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent,
    trackEvent: input.trackEvent,
  });
  const handlerKey = input.handler ?? "added";
  const handler = handlerKey === "removed" ? removed : added;
  expect(handler).toBeTruthy();
  const event = (input.event ?? makePinEvent()) as Record<string, unknown>;
  const body = input.body ?? {};
  await handler!({
    body,
    event,
  });
}

describe("registerSlackPinEvents", () => {
  beforeAll(async () => {
    ({ registerSlackPinEvents } = await import("./pins.js"));
    ({ createSlackSystemEventTestHarness: buildPinHarness } =
      await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    pinEnqueueMock.mockClear();
  });

  const cases: { name: string; args: PinCase; expectedCalls: number }[] = [
    {
      args: { overrides: { dmPolicy: "open" } },
      expectedCalls: 1,
      name: "enqueues DM pin system events when dmPolicy is open",
    },
    {
      args: { overrides: { dmPolicy: "disabled" } },
      expectedCalls: 0,
      name: "blocks DM pin system events when dmPolicy is disabled",
    },
    {
      args: {
        event: makePinEvent({ user: "U1" }),
        overrides: { allowFrom: ["U2"], dmPolicy: "allowlist" },
      },
      expectedCalls: 0,
      name: "blocks DM pin system events for unauthorized senders in allowlist mode",
    },
    {
      args: {
        event: makePinEvent({ user: "U1" }),
        overrides: { allowFrom: ["U1"], dmPolicy: "allowlist" },
      },
      expectedCalls: 1,
      name: "allows DM pin system events for authorized senders in allowlist mode",
    },
    {
      args: {
        event: makePinEvent({ channel: "C1", user: "U_ATTACKER" }),
        overrides: {
          channelType: "channel",
          channelUsers: ["U_OWNER"],
          dmPolicy: "open",
        },
      },
      expectedCalls: 0,
      name: "blocks channel pin events for users outside channel users allowlist",
    },
  ];
  it.each(cases)("$name", async ({ args, expectedCalls }) => {
    await runPinCase(args);
    expect(pinEnqueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({
      body: { api_app_id: "A_OTHER" },
      shouldDropMismatchedSlackEvent: () => true,
      trackEvent,
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted pin events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
