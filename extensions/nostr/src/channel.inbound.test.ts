import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import type { PluginRuntime } from "../runtime-api.js";
import { startNostrGatewayAccount } from "./gateway.js";
import { setNostrRuntime } from "./runtime.js";
import { buildResolvedNostrAccount } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  normalizePubkey: vi.fn((value: string) =>
    value
      .trim()
      .replace(/^nostr:/i, "")
      .toLowerCase(),
  ),
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  getPublicKeyFromPrivate: vi.fn(() => "bot-pubkey"),
  normalizePubkey: mocks.normalizePubkey,
  startNostrBus: mocks.startNostrBus,
}));

function createMockBus() {
  return {
    close: vi.fn(),
    getMetrics: vi.fn(() => ({ counters: {} })),
    getProfileState: vi.fn(async () => null),
    publishProfile: vi.fn(),
    sendDm: vi.fn(async () => {}),
  };
}

function createRuntimeHarness() {
  const recordInboundSession = vi.fn(async () => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "|a|b|" });
  });
  const runtime = {
    channel: {
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
        shouldComputeCommandAuthorized: vi.fn(() => true),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR1234", created: true })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        finalizeInboundContext: vi.fn((ctx) => ctx),
        formatAgentEnvelope: vi.fn(({ body }) => `envelope:${body}`),
        resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
      },
      routing: {
        resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
          accountId,
          agentId: "agent-nostr",
          sessionKey: `nostr:${peer.id}`,
        })),
      },
      session: {
        readSessionUpdatedAt: vi.fn(() => undefined),
        recordInboundSession,
        resolveStorePath: vi.fn(() => "/tmp/nostr-session-store"),
      },
      text: {
        convertMarkdownTables: vi.fn((text: string) => `converted:${text}`),
        resolveMarkdownTableMode: vi.fn(() => "off"),
      },
    },
  } as unknown as PluginRuntime;

  return {
    dispatchReplyWithBufferedBlockDispatcher,
    recordInboundSession,
    runtime,
  };
}

async function startGatewayHarness(params: {
  account: ReturnType<typeof buildResolvedNostrAccount>;
  cfg?: Parameters<typeof createStartAccountContext>[0]["cfg"];
}) {
  const harness = createRuntimeHarness();
  const bus = createMockBus();
  setNostrRuntime(harness.runtime);
  mocks.startNostrBus.mockResolvedValueOnce(bus as never);

  const cleanup = (await startNostrGatewayAccount(
    createStartAccountContext({
      account: params.account,
      cfg: params.cfg,
    }),
  )) as { stop: () => void };

  return { bus, cleanup, harness };
}

describe("nostr inbound gateway path", () => {
  afterEach(() => {
    mocks.normalizePubkey.mockClear();
    mocks.startNostrBus.mockReset();
  });

  it("issues a pairing reply before decrypt for unknown senders", async () => {
    const { cleanup } = await startGatewayHarness({
      account: buildResolvedNostrAccount({
        config: { allowFrom: [], dmPolicy: "pairing" },
      }),
    });

    const options = mocks.startNostrBus.mock.calls[0]?.[0] as {
      authorizeSender: (params: {
        senderPubkey: string;
        reply: (text: string) => Promise<void>;
      }) => Promise<string>;
    };
    const sendPairingReply = vi.fn(async (_text: string) => {});

    await expect(
      options.authorizeSender({
        reply: sendPairingReply,
        senderPubkey: "nostr:UNKNOWN-SENDER",
      }),
    ).resolves.toBe("pairing");
    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(sendPairingReply.mock.calls[0]?.[0]).toContain("Pairing code:");

    cleanup.stop();
  });

  it("routes allowed DMs through the standard reply pipeline", async () => {
    const { harness, cleanup } = await startGatewayHarness({
      account: buildResolvedNostrAccount({
        config: { allowFrom: ["nostr:sender-pubkey"], dmPolicy: "allowlist" },
        publicKey: "bot-pubkey",
      }),
      cfg: {
        commands: { useAccessGroups: true },
        session: { store: { type: "jsonl" } },
      } as never,
    });

    const options = mocks.startNostrBus.mock.calls[0]?.[0] as {
      onMessage: (
        senderPubkey: string,
        text: string,
        reply: (text: string) => Promise<void>,
        meta: { eventId: string; createdAt: number },
      ) => Promise<void>;
    };
    const sendReply = vi.fn(async (_text: string) => {});

    await options.onMessage("sender-pubkey", "hello from nostr", sendReply, {
      createdAt: 1_710_000_000,
      eventId: "event-123",
    });

    expect(harness.recordInboundSession).toHaveBeenCalledTimes(1);
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(harness.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx).toMatchObject({
      BodyForAgent: "hello from nostr",
      CommandAuthorized: true,
      MessageSid: "event-123",
      SenderId: "sender-pubkey",
    });
    expect(sendReply).toHaveBeenCalledWith("converted:|a|b|");

    cleanup.stop();
  });
});
