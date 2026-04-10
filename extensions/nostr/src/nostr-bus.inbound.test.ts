import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNostrBus } from "./nostr-bus.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

const BOT_PUBKEY = "b".repeat(64);

const mockState = vi.hoisted(() => ({
  decrypt: vi.fn(() => "plaintext"),
  handlers: null as {
    onevent: (event: Record<string, unknown>) => void | Promise<void>;
    oneose?: () => void;
    onclose?: (reason: string[]) => void;
  } | null,
  publishProfile: vi.fn(async () => ({
    createdAt: 0,
    eventId: "profile-event",
    failures: [],
    successes: [],
  })),
  verifyEvent: vi.fn(() => true),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    subscribeMany(
      _relays: string[],
      _filters: unknown,
      handlers: {
        onevent: (event: Record<string, unknown>) => void | Promise<void>;
        oneose?: () => void;
        onclose?: (reason: string[]) => void;
      },
    ) {
      mockState.handlers = handlers;
      return {
        close: vi.fn(),
      };
    }

    publish = vi.fn(async () => {});
  }

  return {
    SimplePool: MockSimplePool,
    finalizeEvent: vi.fn((event: unknown) => event),
    getPublicKey: vi.fn(() => BOT_PUBKEY),
    nip19: {
      decode: vi.fn(),
      npubEncode: vi.fn((value: string) => `npub-${value}`),
    },
    verifyEvent: mockState.verifyEvent,
  };
});

vi.mock("nostr-tools/nip04", () => ({
  decrypt: mockState.decrypt,
  encrypt: vi.fn(() => "ciphertext"),
}));

vi.mock("./nostr-state-store.js", () => ({
  computeSinceTimestamp: vi.fn(() => 0),
  readNostrBusState: vi.fn(async () => null),
  readNostrProfileState: vi.fn(async () => null),
  writeNostrBusState: vi.fn(async () => {}),
  writeNostrProfileState: vi.fn(async () => {}),
}));

vi.mock("./nostr-profile.js", () => ({
  publishProfile: mockState.publishProfile,
}));

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    content: "ciphertext",
    created_at: Math.floor(Date.now() / 1000),
    id: "event-1",
    kind: 4,
    pubkey: "a".repeat(64),
    tags: [["p", BOT_PUBKEY]],
    ...overrides,
  };
}

async function emitEvent(event: Record<string, unknown>) {
  if (!mockState.handlers) {
    throw new Error("missing subscription handlers");
  }
  await mockState.handlers.onevent(event);
}

describe("startNostrBus inbound guards", () => {
  beforeEach(() => {
    mockState.handlers = null;
    mockState.verifyEvent.mockClear();
    mockState.verifyEvent.mockReturnValue(true);
    mockState.decrypt.mockClear();
    mockState.decrypt.mockReturnValue("plaintext");
  });

  afterEach(() => {
    mockState.handlers = null;
  });

  it("checks sender authorization after verify and before decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "block" as const);
    const bus = await startNostrBus({
      authorizeSender,
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(createEvent());

    expect(authorizeSender).toHaveBeenCalledTimes(1);
    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsReceived).toBe(1);

    bus.close();
  });

  it("rejects invalid signatures before sender authorization", async () => {
    mockState.verifyEvent.mockReturnValueOnce(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startNostrBus({
      authorizeSender,
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(createEvent());

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsRejected.invalidSignature).toBe(1);

    bus.close();
  });

  it("rate limits repeated events before decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    for (let i = 0; i < 21; i += 1) {
      await emitEvent(
        createEvent({
          id: `event-${i}`,
        }),
      );
    }

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.rateLimited).toBe(1);
    expect(mockState.decrypt).toHaveBeenCalledTimes(20);
    expect(onMessage).toHaveBeenCalledTimes(20);

    bus.close();
  });

  it("does not let a blocked sender starve a different verified sender", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async ({ senderPubkey }: { senderPubkey: string }) =>
      senderPubkey.startsWith("blocked") ? ("block" as const) : ("allow" as const),
    );
    const bus = await startNostrBus({
      authorizeSender,
      guardPolicy: {
        rateLimit: {
          maxGlobalPerWindow: 2,
          maxPerSenderPerWindow: 1,
          maxTrackedSenderKeys: 32,
          windowMs: 60_000,
        },
      },
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(
      createEvent({
        id: "blocked-event",
        pubkey: `blocked${"a".repeat(57)}`,
      }),
    );
    await emitEvent(
      createEvent({
        id: "allowed-event",
        pubkey: `allowed${"b".repeat(57)}`,
      }),
    );

    expect(authorizeSender).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(0);

    bus.close();
  });

  it("dedupes replayed verified events that authorization blocks", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "block" as const);
    const bus = await startNostrBus({
      authorizeSender,
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    const blockedEvent = createEvent({
      id: "blocked-replay",
      pubkey: `blocked${"a".repeat(57)}`,
    });

    await emitEvent(blockedEvent);
    await emitEvent(blockedEvent);

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).toHaveBeenCalledTimes(1);
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });

  it("does not rate limit an allowed sender while another authorization is still pending", async () => {
    const onMessage = vi.fn(async () => {});
    let resolveBlocked: ((value: "block") => void) | undefined;
    const blockedPromise = new Promise<"block">((resolve) => {
      resolveBlocked = resolve;
    });
    const authorizeSender = vi
      .fn<(params: { senderPubkey: string }) => Promise<"allow" | "block" | "pairing">>()
      .mockImplementationOnce(async () => await blockedPromise)
      .mockResolvedValueOnce("allow");
    const bus = await startNostrBus({
      authorizeSender,
      guardPolicy: {
        rateLimit: {
          maxGlobalPerWindow: 2,
          maxPerSenderPerWindow: 1,
          maxTrackedSenderKeys: 32,
          windowMs: 60_000,
        },
      },
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    const blockedEventPromise = emitEvent(
      createEvent({
        id: "blocked-pending",
        pubkey: `blocked${"a".repeat(57)}`,
      }),
    );
    await emitEvent(
      createEvent({
        id: "allowed-during-pending-auth",
        pubkey: `allowed${"b".repeat(57)}`,
      }),
    );
    resolveBlocked?.("block");
    await blockedEventPromise;

    expect(authorizeSender).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(0);

    bus.close();
  });

  it("rate limits repeated invalid signatures before authorization work fans out", async () => {
    mockState.verifyEvent.mockReturnValue(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startNostrBus({
      authorizeSender,
      guardPolicy: {
        rateLimit: {
          maxGlobalPerWindow: 1,
          maxPerSenderPerWindow: 10,
          maxTrackedSenderKeys: 32,
          windowMs: 60_000,
        },
      },
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(createEvent({ id: "invalid-1" }));
    await emitEvent(createEvent({ id: "invalid-2" }));

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsRejected.invalidSignature).toBe(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(1);

    bus.close();
  });

  it("counts oversized ciphertext toward the global inbound rate limit", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      guardPolicy: {
        maxCiphertextBytes: 4,
        rateLimit: {
          maxGlobalPerWindow: 1,
          maxPerSenderPerWindow: 10,
          maxTrackedSenderKeys: 32,
          windowMs: 60_000,
        },
      },
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(
      createEvent({
        content: "ciphertext-too-large",
        id: "oversized-global-1",
        pubkey: `sender1${"a".repeat(57)}`,
      }),
    );
    await emitEvent(
      createEvent({
        content: "ciphertext-too-large",
        id: "oversized-global-2",
        pubkey: `sender2${"b".repeat(57)}`,
      }),
    );

    expect(bus.getMetrics().eventsRejected.oversizedCiphertext).toBe(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });

  it("does not spend per-sender buckets on oversized ciphertext before verification", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      guardPolicy: {
        maxCiphertextBytes: 4,
        rateLimit: {
          maxGlobalPerWindow: 10,
          maxPerSenderPerWindow: 1,
          maxTrackedSenderKeys: 32,
          windowMs: 60_000,
        },
      },
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(
      createEvent({
        content: "ciphertext-too-large",
        id: "oversized-sender-1",
      }),
    );
    await emitEvent(
      createEvent({
        content: "ciphertext-too-large",
        id: "oversized-sender-2",
      }),
    );
    await emitEvent(
      createEvent({
        content: "ok",
        id: "allowed-after-oversized",
      }),
    );

    expect(bus.getMetrics().eventsRejected.oversizedCiphertext).toBe(2);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(0);
    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(mockState.decrypt).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);

    bus.close();
  });

  it("rejects far-future events before crypto", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(
      createEvent({
        created_at: Math.floor(Date.now() / 1000) + 600,
      }),
    );

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.future).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });

  it("rejects oversized ciphertext before verify/decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      onMessage,
      onMetric: () => {},
      privateKey: TEST_HEX_PRIVATE_KEY,
    });

    await emitEvent(
      createEvent({
        content: "x".repeat(20_000),
      }),
    );

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.oversizedCiphertext).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });
});
