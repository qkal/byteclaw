import { describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixVerificationSummary } from "../sdk/verification-manager.js";
import { registerMatrixMonitorEvents } from "./events.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

type RoomEventListener = (roomId: string, event: MatrixRawEvent) => void;
type FailedDecryptListener = (roomId: string, event: MatrixRawEvent, error: Error) => Promise<void>;
type VerificationSummaryListener = (summary: MatrixVerificationSummary) => void;

function getSentNoticeBody(sendMessage: ReturnType<typeof vi.fn>, index = 0): string {
  const calls = sendMessage.mock.calls as unknown[][];
  const payload = (calls[index]?.[1] ?? {}) as { body?: string };
  return payload.body ?? "";
}

function createHarness(params?: {
  cfg?: CoreConfig;
  accountId?: string;
  authEncryption?: boolean;
  cryptoAvailable?: boolean;
  selfUserId?: string;
  selfUserIdError?: Error;
  allowFrom?: string[];
  dmEnabled?: boolean;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  storeAllowFrom?: string[];
  accountDataByType?: Record<string, unknown>;
  joinedMembersByRoom?: Record<string, string[]>;
  getJoinedRoomsError?: Error;
  memberStateByRoomUser?: Record<string, Record<string, { is_direct?: boolean }>>;
  verifications?: {
    id: string;
    transactionId?: string;
    roomId?: string;
    otherUserId: string;
    updatedAt?: string;
    completed?: boolean;
    pending?: boolean;
    phase?: number;
    phaseName?: string;
    sas?: {
      decimal?: [number, number, number];
      emoji?: [string, string][];
    };
  }[];
  ensureVerificationDmTracked?: () => Promise<{
    id: string;
    transactionId?: string;
    roomId?: string;
    otherUserId: string;
    updatedAt?: string;
    completed?: boolean;
    pending?: boolean;
    phase?: number;
    phaseName?: string;
    sas?: {
      decimal?: [number, number, number];
      emoji?: [string, string][];
    };
  } | null>;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const onRoomMessage = vi.fn(async () => {});
  const listVerifications = vi.fn(async () => params?.verifications ?? []);
  const ensureVerificationDmTracked = vi.fn(
    params?.ensureVerificationDmTracked ?? (async () => null),
  );
  const sendMessage = vi.fn(async (_roomId: string, _payload: { body?: string }) => "$notice");
  const invalidateRoom = vi.fn();
  const rememberInvite = vi.fn();
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const formatNativeDependencyHint = vi.fn(() => "install hint");
  const logVerboseMessage = vi.fn();
  const readStoreAllowFrom = vi.fn(async () => params?.storeAllowFrom ?? []);
  const client = {
    getAccountData: vi.fn(
      async (eventType: string) =>
        (params?.accountDataByType?.[eventType] as Record<string, unknown> | undefined) ??
        undefined,
    ),
    getJoinedRoomMembers: vi.fn(
      async (roomId: string) =>
        params?.joinedMembersByRoom?.[roomId] ?? ["@bot:example.org", "@alice:example.org"],
    ),
    getJoinedRooms: vi.fn(async () =>
      params?.getJoinedRoomsError
        ? await Promise.reject(params.getJoinedRoomsError)
        : (Object.keys(params?.joinedMembersByRoom ?? {}).length > 0
          ? Object.keys(params?.joinedMembersByRoom ?? {})
          : ["!room:example.org"]),
    ),
    getRoomStateEvent: vi.fn(
      async (roomId: string, _eventType: string, stateKey: string) =>
        params?.memberStateByRoomUser?.[roomId]?.[stateKey] ?? {},
    ),
    getUserId: vi.fn(async () => {
      if (params?.selfUserIdError) {
        throw params.selfUserIdError;
      }
      return params?.selfUserId ?? "@bot:example.org";
    }),
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      listeners.set(eventName, listener);
      return client;
    }),
    sendMessage,
    ...(params?.cryptoAvailable === false
      ? {}
      : {
          crypto: {
            ensureVerificationDmTracked,
            listVerifications,
          },
        }),
  } as unknown as MatrixClient;

  registerMatrixMonitorEvents({
    allowFrom: params?.allowFrom ?? [],
    auth: {
      accountId: params?.accountId ?? "default",
      encryption: params?.authEncryption ?? true,
    } as MatrixAuth,
    cfg: params?.cfg ?? { channels: { matrix: {} } },
    client,
    directTracker: {
      invalidateRoom,
      rememberInvite,
    },
    dmEnabled: params?.dmEnabled ?? true,
    dmPolicy: params?.dmPolicy ?? "open",
    formatNativeDependencyHint,
    logVerboseMessage,
    logger,
    onRoomMessage,
    readStoreAllowFrom,
    warnedCryptoMissingRooms: new Set<string>(),
    warnedEncryptedRooms: new Set<string>(),
  });

  const roomEventListener = listeners.get("room.event") as RoomEventListener | undefined;
  if (!roomEventListener) {
    throw new Error("room.event listener was not registered");
  }

  return {
    failedDecryptListener: listeners.get("room.failed_decryption") as
      | FailedDecryptListener
      | undefined,
    formatNativeDependencyHint,
    invalidateRoom,
    listVerifications,
    logVerboseMessage,
    logger,
    onRoomMessage,
    readStoreAllowFrom,
    rememberInvite,
    roomEventListener,
    roomInviteListener: listeners.get("room.invite") as RoomEventListener | undefined,
    roomJoinListener: listeners.get("room.join") as RoomEventListener | undefined,
    roomMessageListener: listeners.get("room.message") as RoomEventListener | undefined,
    sendMessage,
    verificationSummaryListener: listeners.get("verification.summary") as
      | VerificationSummaryListener
      | undefined,
  };
}

describe("registerMatrixMonitorEvents verification routing", () => {
  it("does not repost historical verification completions during startup catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T13:10:00.000Z"));
    try {
      const { sendMessage, roomEventListener } = createHarness();

      roomEventListener("!room:example.org", {
        content: {
          "m.relates_to": { event_id: "$req-old" },
        },
        event_id: "$done-old",
        origin_server_ts: Date.now() - 10 * 60 * 1000,
        sender: "@alice:example.org",
        type: "m.key.verification.done",
      });

      await vi.runAllTimersAsync();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still posts fresh verification completions", async () => {
    const { sendMessage, roomEventListener } = createHarness();

    roomEventListener("!room:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-fresh" },
      },
      event_id: "$done-fresh",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.done",
    });

    await vi.dynamicImportSettled();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(getSentNoticeBody(sendMessage)).toContain(
      "Matrix verification completed with @alice:example.org.",
    );
  });

  it("forwards reaction room events into the shared room handler", async () => {
    const { onRoomMessage, sendMessage, roomEventListener } = createHarness();

    roomEventListener("!room:example.org", {
      content: {
        "m.relates_to": {
          event_id: "$msg1",
          key: "👍",
          rel_type: "m.annotation",
        },
      },
      event_id: "$reaction1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.Reaction,
    });

    await vi.waitFor(() => {
      expect(onRoomMessage).toHaveBeenCalledWith(
        "!room:example.org",
        expect.objectContaining({ event_id: "$reaction1", type: EventType.Reaction }),
      );
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("invalidates direct-room membership cache on room member events", async () => {
    const { invalidateRoom, roomEventListener } = createHarness();

    roomEventListener("!room:example.org", {
      content: {
        membership: "join",
      },
      event_id: "$member1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      state_key: "@mallory:example.org",
      type: EventType.RoomMember,
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("remembers invite provenance on room invites", async () => {
    const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
    if (!roomInviteListener) {
      throw new Error("room.invite listener was not registered");
    }

    roomInviteListener("!room:example.org", {
      content: {
        is_direct: true,
        membership: "invite",
      },
      event_id: "$invite1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      state_key: "@bot:example.org",
      type: EventType.RoomMember,
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).toHaveBeenCalledWith("!room:example.org", "@alice:example.org");
  });

  it("ignores lifecycle-only invite events emitted with self sender ids", async () => {
    const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
    if (!roomInviteListener) {
      throw new Error("room.invite listener was not registered");
    }

    roomInviteListener("!room:example.org", {
      content: {
        membership: "invite",
      },
      event_id: "$invite-self",
      origin_server_ts: Date.now(),
      sender: "@bot:example.org",
      state_key: "@bot:example.org",
      type: EventType.RoomMember,
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).not.toHaveBeenCalled();
  });

  it("remembers invite provenance even when Matrix omits the direct invite hint", async () => {
    const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
    if (!roomInviteListener) {
      throw new Error("room.invite listener was not registered");
    }

    roomInviteListener("!room:example.org", {
      content: {
        membership: "invite",
      },
      event_id: "$invite-group",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      state_key: "@bot:example.org",
      type: EventType.RoomMember,
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).toHaveBeenCalledWith("!room:example.org", "@alice:example.org");
  });

  it("does not synthesize invite provenance from room joins", async () => {
    const { invalidateRoom, rememberInvite, roomJoinListener } = createHarness();
    if (!roomJoinListener) {
      throw new Error("room.join listener was not registered");
    }

    roomJoinListener("!room:example.org", {
      content: {
        membership: "join",
      },
      event_id: "$join1",
      origin_server_ts: Date.now(),
      sender: "@bot:example.org",
      state_key: "@bot:example.org",
      type: EventType.RoomMember,
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).not.toHaveBeenCalled();
  });

  it("posts verification request notices directly into the room", async () => {
    const { onRoomMessage, sendMessage, roomMessageListener } = createHarness();
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }
    roomMessageListener("!room:example.org", {
      content: {
        body: "verification request",
        msgtype: "m.key.verification.request",
      },
      event_id: "$req1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(onRoomMessage).not.toHaveBeenCalled();
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification request received from @alice:example.org.");
    expect(body).toContain('Open "Verify by emoji"');
  });

  it("blocks verification request notices when dmPolicy pairing would block the sender", async () => {
    const { onRoomMessage, sendMessage, roomMessageListener, logVerboseMessage } = createHarness({
      dmPolicy: "pairing",
    });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      content: {
        body: "verification request",
        msgtype: "m.key.verification.request",
      },
      event_id: "$req-pairing-blocked",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
    });

    await vi.waitFor(() => {
      expect(logVerboseMessage).toHaveBeenCalledWith(
        expect.stringContaining("blocked verification sender @alice:example.org"),
      );
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onRoomMessage).not.toHaveBeenCalled();
  });

  it("allows verification notices for pairing-authorized DM senders from the allow store", async () => {
    const { sendMessage, roomMessageListener, readStoreAllowFrom } = createHarness({
      dmPolicy: "pairing",
      storeAllowFrom: ["@alice:example.org"],
    });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      content: {
        body: "verification request",
        msgtype: "m.key.verification.request",
      },
      event_id: "$req-pairing-allowed",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(readStoreAllowFrom).toHaveBeenCalled();
  });

  it("does not consult the allow store when dmPolicy is open", async () => {
    const { sendMessage, roomMessageListener, readStoreAllowFrom } = createHarness({
      dmPolicy: "open",
    });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      content: {
        body: "verification request",
        msgtype: "m.key.verification.request",
      },
      event_id: "$req-open-policy",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(readStoreAllowFrom).not.toHaveBeenCalled();
  });

  it("blocks verification notices when Matrix DMs are disabled", async () => {
    const { sendMessage, roomMessageListener, logVerboseMessage } = createHarness({
      dmEnabled: false,
    });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      content: {
        body: "verification request",
        msgtype: "m.key.verification.request",
      },
      event_id: "$req-dm-disabled",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
    });

    await vi.waitFor(() => {
      expect(logVerboseMessage).toHaveBeenCalledWith(
        expect.stringContaining("blocked verification sender @alice:example.org"),
      );
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("posts ready-stage guidance for emoji verification", async () => {
    const { sendMessage, roomEventListener } = createHarness();
    roomEventListener("!room:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-ready-1" },
      },
      event_id: "$ready-1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.ready",
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification is ready with @alice:example.org.");
    expect(body).toContain('Choose "Verify by emoji"');
  });

  it("posts SAS emoji/decimal details when verification summaries expose them", async () => {
    const {
      sendMessage,
      roomEventListener,
      listVerifications: _listVerifications,
    } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-1",
          otherUserId: "@alice:example.org",
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
          transactionId: "$different-flow-id",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      content: {
        "m.relates_to": { event_id: "$req2" },
      },
      event_id: "$start2",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS emoji:"))).toBe(true);
      expect(bodies.some((body) => body.includes("SAS decimal: 6158 1986 3513"))).toBe(true);
    });
  });

  it("rehydrates an in-progress DM verification before resolving SAS notices", async () => {
    const verifications: {
      id: string;
      transactionId?: string;
      roomId?: string;
      otherUserId: string;
      updatedAt?: string;
      completed?: boolean;
      pending?: boolean;
      phase?: number;
      phaseName?: string;
      sas?: {
        decimal?: [number, number, number];
        emoji?: [string, string][];
      };
    }[] = [];
    const { sendMessage, roomEventListener } = createHarness({
      ensureVerificationDmTracked: async () => {
        verifications.splice(0, verifications.length, {
          id: "verification-rehydrated",
          otherUserId: "@alice:example.org",
          pending: true,
          phase: 3,
          phaseName: "started",
          roomId: "!dm:example.org",
          sas: {
            decimal: [2468, 1357, 9753],
            emoji: [
              ["🔔", "Bell"],
              ["📁", "Folder"],
              ["🐴", "Horse"],
            ],
          },
          transactionId: "$req-hydrated",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
        });
        return verifications[0] ?? null;
      },
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications,
    });

    roomEventListener("!dm:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-hydrated" },
      },
      event_id: "$start-hydrated",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS decimal: 2468 1357 9753"))).toBe(true);
    });
  });

  it("posts SAS notices directly from verification summary updates", async () => {
    const { sendMessage, verificationSummaryListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      canAccept: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      hasReciprocateQr: false,
      hasSas: true,
      id: "verification-direct",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      roomId: "!dm:example.org",
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification SAS with @alice:example.org:");
    expect(body).toContain("SAS decimal: 6158 1986 3513");
  });

  it("blocks summary SAS notices when dmPolicy allowlist would block the sender", async () => {
    const { sendMessage, verificationSummaryListener, logVerboseMessage } = createHarness({
      dmPolicy: "allowlist",
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      canAccept: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      hasReciprocateQr: false,
      hasSas: true,
      id: "verification-blocked-summary",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      roomId: "!dm:example.org",
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await vi.waitFor(() => {
      expect(logVerboseMessage).toHaveBeenCalledWith(
        expect.stringContaining("blocked verification sender @alice:example.org"),
      );
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("posts SAS notices from summary updates using the room mapped by earlier flow events", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    roomEventListener("!dm:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-mapped" },
        transaction_id: "txn-mapped-room",
      },
      event_id: "$start-mapped",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    verificationSummaryListener({
      canAccept: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      hasReciprocateQr: false,
      hasSas: true,
      id: "verification-mapped",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      sas: {
        decimal: [1111, 2222, 3333],
        emoji: [
          ["🚀", "Rocket"],
          ["🦋", "Butterfly"],
          ["📕", "Book"],
        ],
      },
      transactionId: "txn-mapped-room",
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS decimal: 1111 2222 3333"))).toBe(true);
    });
  });

  it("posts SAS notices from summary updates using the active strict DM when room mapping is missing", async () => {
    const { sendMessage, verificationSummaryListener } = createHarness({
      joinedMembersByRoom: {
        "!dm-active:example.org": ["@alice:example.org", "@bot:example.org"],
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      canAccept: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      hasReciprocateQr: false,
      hasSas: true,
      id: "verification-unmapped",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      sas: {
        decimal: [4321, 8765, 2109],
        emoji: [
          ["🚀", "Rocket"],
          ["🦋", "Butterfly"],
          ["📕", "Book"],
        ],
      },
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    const roomId = ((sendMessage.mock.calls as unknown[][])[0]?.[0] ?? "") as string;
    const body = getSentNoticeBody(sendMessage, 0);
    expect(roomId).toBe("!dm-active:example.org");
    expect(body).toContain("SAS decimal: 4321 8765 2109");
  });

  it("prefers the canonical active DM over the most recent verification room for unmapped SAS summaries", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener } = createHarness({
      joinedMembersByRoom: {
        "!dm-active:example.org": ["@alice:example.org", "@bot:example.org"],
        "!dm-current:example.org": ["@alice:example.org", "@bot:example.org"],
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    roomEventListener("!dm-current:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-current" },
      },
      event_id: "$start-current",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("Matrix verification started with"))).toBe(true);
    });

    verificationSummaryListener({
      canAccept: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      hasReciprocateQr: false,
      hasSas: true,
      id: "verification-current-room",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      sas: {
        decimal: [2468, 1357, 9753],
        emoji: [
          ["🔔", "Bell"],
          ["📁", "Folder"],
          ["🐴", "Horse"],
        ],
      },
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS decimal: 2468 1357 9753"))).toBe(true);
    });
    const calls = sendMessage.mock.calls as unknown[][];
    const sasCall = calls.find((call) =>
      String((call[1] as { body?: string } | undefined)?.body ?? "").includes(
        "SAS decimal: 2468 1357 9753",
      ),
    );
    expect((sasCall?.[0] ?? "") as string).toBe("!dm-active:example.org");
  });

  it("retries SAS notice lookup when start arrives before SAS payload is available", async () => {
    vi.useFakeTimers();
    const verifications: {
      id: string;
      transactionId?: string;
      otherUserId: string;
      updatedAt?: string;
      sas?: {
        decimal?: [number, number, number];
        emoji?: [string, string][];
      };
    }[] = [
      {
        id: "verification-race",
        otherUserId: "@alice:example.org",
        transactionId: "$req-race",
        updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      },
    ];
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications,
    });

    try {
      roomEventListener("!dm:example.org", {
        content: {
          "m.relates_to": { event_id: "$req-race" },
        },
        event_id: "$start-race",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.key.verification.start",
      });

      await vi.advanceTimersByTimeAsync(500);
      verifications[0] = {
        ...verifications[0],
        sas: {
          decimal: [1234, 5678, 9012],
          emoji: [
            ["🚀", "Rocket"],
            ["🦋", "Butterfly"],
            ["📕", "Book"],
          ],
        },
      };
      await vi.advanceTimersByTimeAsync(500);

      await vi.waitFor(() => {
        const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
          String((call[1] as { body?: string } | undefined)?.body ?? ""),
        );
        expect(bodies.some((body) => body.includes("SAS emoji:"))).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores verification notices in unrelated non-DM rooms", async () => {
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: {
        "!group:example.org": ["@alice:example.org", "@bot:example.org", "@ops:example.org"],
      },
      verifications: [
        {
          id: "verification-2",
          otherUserId: "@alice:example.org",
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
          transactionId: "$different-flow-id",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
        },
      ],
    });

    roomEventListener("!group:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-group" },
      },
      event_id: "$start-group",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(0);
    });
  });

  it("routes unmapped verification summaries to the room marked direct in member state", async () => {
    const { sendMessage, verificationSummaryListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
        "!fallback:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      memberStateByRoomUser: {
        "!dm:example.org": {
          "@bot:example.org": { is_direct: true },
        },
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      canAccept: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      hasReciprocateQr: false,
      hasSas: true,
      id: "verification-explicit-room",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect((sendMessage.mock.calls as unknown[][])[0]?.[0]).toBe("!dm:example.org");
  });

  it("prefers the active direct room over a stale remembered strict room for unmapped summaries", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
        "!fallback:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      memberStateByRoomUser: {
        "!dm:example.org": {
          "@bot:example.org": { is_direct: true },
        },
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    roomEventListener("!fallback:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-fallback" },
      },
      event_id: "$start-fallback",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    sendMessage.mockClear();

    verificationSummaryListener({
      canAccept: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      hasReciprocateQr: false,
      hasSas: true,
      id: "verification-stale-room",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect((sendMessage.mock.calls as unknown[][])[0]?.[0]).toBe("!dm:example.org");
  });

  it("does not emit duplicate SAS notices for the same verification payload", async () => {
    const { sendMessage, roomEventListener, listVerifications } = createHarness({
      verifications: [
        {
          id: "verification-3",
          otherUserId: "@alice:example.org",
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
          transactionId: "$req3",
        },
      ],
    });

    roomEventListener("!room:example.org", {
      content: {
        "m.relates_to": { event_id: "$req3" },
      },
      event_id: "$start3",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });
    await vi.waitFor(() => {
      expect(sendMessage.mock.calls.length).toBeGreaterThan(0);
    });

    roomEventListener("!room:example.org", {
      content: {
        "m.relates_to": { event_id: "$req3" },
      },
      event_id: "$key3",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.key",
    });
    await vi.waitFor(() => {
      expect(listVerifications).toHaveBeenCalledTimes(2);
    });

    const sasBodies = sendMessage.mock.calls
      .map((call) => String(((call as unknown[])[1] as { body?: string } | undefined)?.body ?? ""))
      .filter((body) => body.includes("SAS emoji:"));
    expect(sasBodies).toHaveLength(1);
  });

  it("ignores cancelled verification flows when DM fallback resolves SAS notices", async () => {
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-old-cancelled",
          otherUserId: "@alice:example.org",
          pending: false,
          phase: 4,
          phaseName: "cancelled",
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
          transactionId: "$old-flow",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
        },
        {
          id: "verification-new-active",
          otherUserId: "@alice:example.org",
          pending: true,
          phase: 3,
          phaseName: "started",
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
          transactionId: "$different-flow-id",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-active" },
      },
      event_id: "$start-active",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS decimal: 6158 1986 3513"))).toBe(true);
    });
    const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
      String((call[1] as { body?: string } | undefined)?.body ?? ""),
    );
    expect(bodies.some((body) => body.includes("SAS decimal: 1111 2222 3333"))).toBe(false);
  });

  it("preserves strict-room SAS fallback when active DM inspection cannot resolve a room", async () => {
    const { sendMessage, roomEventListener } = createHarness({
      getJoinedRoomsError: new Error("temporary joined-room lookup failure"),
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-active",
          otherUserId: "@alice:example.org",
          pending: true,
          phase: 3,
          phaseName: "started",
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
          transactionId: "$different-flow-id",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-active" },
      },
      event_id: "$start-active",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS decimal: 6158 1986 3513"))).toBe(true);
    });
  });

  it("prefers the active verification for the current DM when multiple active summaries exist", async () => {
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: {
        "!dm-current:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-other-room",
          otherUserId: "@alice:example.org",
          pending: true,
          phase: 3,
          phaseName: "started",
          roomId: "!dm-other:example.org",
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
          transactionId: "$different-flow-other",
          updatedAt: new Date("2026-02-25T21:44:54.000Z").toISOString(),
        },
        {
          id: "verification-current-room",
          otherUserId: "@alice:example.org",
          pending: true,
          phase: 3,
          phaseName: "started",
          roomId: "!dm-current:example.org",
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
          transactionId: "$different-flow-current",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
        },
      ],
    });

    roomEventListener("!dm-current:example.org", {
      content: {
        "m.relates_to": { event_id: "$req-room-scoped" },
      },
      event_id: "$start-room-scoped",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.start",
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS decimal: 6158 1986 3513"))).toBe(true);
    });
    const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
      String((call[1] as { body?: string } | undefined)?.body ?? ""),
    );
    expect(bodies.some((body) => body.includes("SAS decimal: 1111 2222 3333"))).toBe(false);
  });

  it("does not emit SAS notices for cancelled verification events", async () => {
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-cancelled",
          otherUserId: "@alice:example.org",
          pending: false,
          phase: 4,
          phaseName: "cancelled",
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
          transactionId: "$req-cancelled",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      content: {
        code: "m.mismatched_sas",
        "m.relates_to": { event_id: "$req-cancelled" },
        reason: "The SAS did not match.",
      },
      event_id: "$cancelled-1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.key.verification.cancel",
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification cancelled by @alice:example.org");
    expect(body).not.toContain("SAS decimal:");
  });

  it("warns once when encrypted events arrive without Matrix encryption enabled", () => {
    const { logger, roomEventListener } = createHarness({
      authEncryption: false,
    });

    roomEventListener("!room:example.org", {
      content: {},
      event_id: "$enc1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
    });
    roomEventListener("!room:example.org", {
      content: {},
      event_id: "$enc2",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("uses the active Matrix account path in encrypted-event warnings", () => {
    const { logger, roomEventListener } = createHarness({
      accountId: "ops",
      authEncryption: false,
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
    });

    roomEventListener("!room:example.org", {
      content: {},
      event_id: "$enc1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.accounts.ops.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("warns once when crypto bindings are unavailable for encrypted rooms", () => {
    const { formatNativeDependencyHint, logger, roomEventListener } = createHarness({
      authEncryption: true,
      cryptoAvailable: false,
    });

    roomEventListener("!room:example.org", {
      content: {},
      event_id: "$enc1",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
    });
    roomEventListener("!room:example.org", {
      content: {},
      event_id: "$enc2",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
    });

    expect(formatNativeDependencyHint).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encryption enabled but crypto is unavailable; install hint",
      { roomId: "!room:example.org" },
    );
  });

  it("adds self-device guidance when decrypt failures come from the same Matrix user", async () => {
    const { logger, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await failedDecryptListener(
      "!room:example.org",
      {
        content: {},
        event_id: "$enc-self",
        origin_server_ts: Date.now(),
        sender: "@gumadeiras:matrix.example.org",
        type: EventType.RoomMessageEncrypted,
      },
      new Error("The sender's device has not sent us the keys for this message."),
    );

    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      "Failed to decrypt message",
      expect.objectContaining({
        eventId: "$enc-self",
        roomId: "!room:example.org",
        sender: "@gumadeiras:matrix.example.org",
        senderMatchesOwnUser: true,
      }),
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "matrix: failed to decrypt a message from this same Matrix user. This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      {
        eventId: "$enc-self",
        roomId: "!room:example.org",
        sender: "@gumadeiras:matrix.example.org",
      },
    );
  });

  it("does not add self-device guidance for decrypt failures from another sender", async () => {
    const { logger, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await failedDecryptListener(
      "!room:example.org",
      {
        content: {},
        event_id: "$enc-other",
        origin_server_ts: Date.now(),
        sender: "@alice:matrix.example.org",
        type: EventType.RoomMessageEncrypted,
      },
      new Error("The sender's device has not sent us the keys for this message."),
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to decrypt message",
      expect.objectContaining({
        eventId: "$enc-other",
        roomId: "!room:example.org",
        sender: "@alice:matrix.example.org",
        senderMatchesOwnUser: false,
      }),
    );
  });

  it("does not throw when getUserId fails during decrypt guidance lookup", async () => {
    const { logger, logVerboseMessage, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserIdError: new Error("lookup failed"),
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await expect(
      failedDecryptListener(
        "!room:example.org",
        {
          content: {},
          event_id: "$enc-lookup-fail",
          origin_server_ts: Date.now(),
          sender: "@gumadeiras:matrix.example.org",
          type: EventType.RoomMessageEncrypted,
        },
        new Error("The sender's device has not sent us the keys for this message."),
      ),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to decrypt message",
      expect.objectContaining({
        eventId: "$enc-lookup-fail",
        roomId: "!room:example.org",
        senderMatchesOwnUser: false,
      }),
    );
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: failed resolving self user id for decrypt warning: Error: lookup failed",
    );
  });
});
