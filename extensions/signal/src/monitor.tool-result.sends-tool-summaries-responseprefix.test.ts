import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import { describe, expect, it, vi } from "vitest";
import { expectPairingReplyText } from "../../../test/helpers/pairing-reply.js";
import {
  config,
  createSignalToolResultConfig,
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

// Import after the harness registers `vi.mock(...)` for Signal internals.
const { monitorSignalProvider } = await import("./monitor.js");

const {
  replyMock,
  sendMock,
  streamMock,
  updateLastRouteMock,
  enqueueSystemEventMock,
  upsertPairingRequestMock,
  waitForTransportReadyMock,
} = getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
type MonitorSignalProviderOptions = NonNullable<Parameters<typeof monitorSignalProvider>[0]>;

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider({
    config: config as OpenClawConfig,
    waitForTransportReady:
      waitForTransportReadyMock as MonitorSignalProviderOptions["waitForTransportReady"],
    ...opts,
  });
}

async function receiveSignalPayloads(params: {
  payloads: unknown[];
  opts?: Partial<MonitorSignalProviderOptions>;
}) {
  const abortController = new AbortController();
  streamMock.mockImplementation(async ({ onEvent }) => {
    for (const payload of params.payloads) {
      await onEvent({
        data: JSON.stringify(payload),
        event: "receive",
      });
    }
    abortController.abort();
  });

  await runMonitorWithMocks({
    abortSignal: abortController.signal,
    autoStart: false,
    baseUrl: SIGNAL_BASE_URL,
    ...params.opts,
  });

  await flush();
}

function hasQueuedReactionEventFor(sender: string) {
  const route = resolveAgentRoute({
    accountId: "default",
    cfg: config as OpenClawConfig,
    channel: "signal",
    peer: { id: normalizeE164(sender), kind: "direct" },
  });
  return enqueueSystemEventMock.mock.calls.some(
    ([text, options]) =>
      typeof text === "string" &&
      text.includes("Signal reaction added") &&
      typeof options === "object" &&
      options !== null &&
      "sessionKey" in options &&
      (options as { sessionKey?: string }).sessionKey === route.sessionKey,
  );
}

function makeBaseEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    sourceName: "Ada",
    sourceNumber: "+15550001111",
    timestamp: 1,
    ...overrides,
  };
}

async function receiveSingleEnvelope(
  envelope: Record<string, unknown>,
  opts?: Partial<MonitorSignalProviderOptions>,
) {
  await receiveSignalPayloads({
    opts,
    payloads: [{ envelope }],
  });
}

function expectNoReplyDeliveryOrRouteUpdate() {
  expect(replyMock).not.toHaveBeenCalled();
  expect(sendMock).not.toHaveBeenCalled();
  expect(updateLastRouteMock).not.toHaveBeenCalled();
}

function setReactionNotificationConfig(mode: "all" | "own", extra: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(
    createSignalToolResultConfig({
      allowFrom: ["*"],
      autoStart: false,
      dmPolicy: "open",
      reactionNotifications: mode,
      ...extra,
    }),
  );
}

describe("monitorSignalProvider tool results", () => {
  it("skips tool summaries with responsePrefix", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            dataMessage: {
              message: "hello",
            },
            sourceName: "Ada",
            sourceNumber: "+15550001111",
            timestamp: 1,
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ allowFrom: [], autoStart: false, dmPolicy: "pairing" }),
    );
    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            dataMessage: {
              message: "hello",
            },
            sourceName: "Ada",
            sourceNumber: "+15550001111",
            timestamp: 1,
          },
        },
      ],
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expectPairingReplyText(String(sendMock.mock.calls[0]?.[1] ?? ""), {
      channel: "signal",
      code: "PAIRCODE",
      idLine: "Your Signal number: +15550001111",
    });
  });

  it("ignores reaction-only messages", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "👍",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2,
      },
    });

    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("ignores reaction-only dataMessage.reaction events (don’t treat as broken attachments)", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      dataMessage: {
        attachments: [{}],
        reaction: {
          emoji: "👍",
          targetAuthor: "+15550002222",
          targetSentTimestamp: 2,
        },
      },
    });

    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("enqueues system events for reaction notifications", async () => {
    setReactionNotificationConfig("all");
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2,
      },
    });

    expect(hasQueuedReactionEventFor("+15550001111")).toBe(true);
  });

  it.each([
    {
      extra: { allowFrom: ["+15550007777"], dmPolicy: "allowlist" } as Record<string, unknown>,
      mode: "all" as const,
      name: "blocks reaction notifications from unauthorized senders when dmPolicy is allowlist",
      shouldEnqueue: false,
      targetAuthor: "+15550002222",
    },
    {
      extra: {
        account: "+15550009999",
        allowFrom: [],
        dmPolicy: "pairing",
      } as Record<string, unknown>,
      mode: "own" as const,
      name: "blocks reaction notifications from unauthorized senders when dmPolicy is pairing",
      shouldEnqueue: false,
      targetAuthor: "+15550009999",
    },
    {
      extra: { allowFrom: ["+15550001111"], dmPolicy: "allowlist" } as Record<string, unknown>,
      mode: "all" as const,
      name: "allows reaction notifications for allowlisted senders when dmPolicy is allowlist",
      shouldEnqueue: true,
      targetAuthor: "+15550002222",
    },
  ])("$name", async ({ mode, extra, targetAuthor, shouldEnqueue }) => {
    setReactionNotificationConfig(mode, extra);
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor,
        targetSentTimestamp: 2,
      },
    });

    expect(hasQueuedReactionEventFor("+15550001111")).toBe(shouldEnqueue);
    expect(sendMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("notifies on own reactions when target includes uuid + phone", async () => {
    setReactionNotificationConfig("own", { account: "+15550002222" });
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor: "+15550002222",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
        targetSentTimestamp: 2,
      },
    });

    expect(hasQueuedReactionEventFor("+15550001111")).toBe(true);
  });

  it("processes messages when reaction metadata is present", async () => {
    replyMock.mockResolvedValue({ text: "pong" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            dataMessage: {
              message: "ping",
            },
            reactionMessage: {
              emoji: "👍",
              targetAuthor: "+15550002222",
              targetSentTimestamp: 2,
            },
            sourceName: "Ada",
            sourceNumber: "+15550001111",
            timestamp: 1,
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not resend pairing code when a request is already pending", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ allowFrom: [], autoStart: false, dmPolicy: "pairing" }),
    );
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const payload = {
      envelope: {
        dataMessage: {
          message: "hello",
        },
        sourceName: "Ada",
        sourceNumber: "+15550001111",
        timestamp: 1,
      },
    };
    await receiveSignalPayloads({
      payloads: [
        payload,
        {
          ...payload,
          envelope: { ...payload.envelope, timestamp: 2 },
        },
      ],
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
