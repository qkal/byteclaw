import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentMessageCache } from "./echo-cache.js";
import { resolveIMessageInboundDecision } from "./inbound-processing.js";
import { createSelfChatCache } from "./self-chat-cache.js";

/**
 * Self-chat dedupe regression tests for #47830.
 *
 * PR #38440 introduced a SentMessageCache to suppress echo messages when the
 * agent replies in iMessage. In self-chat (user messaging themselves), the
 * sender == target so the echo scope collides, causing legitimate user
 * messages to be silently dropped when text happens to match recent agent
 * output.
 *
 * These tests verify:
 *  1. User messages in self-chat are NOT dropped (even if text matches agent output)
 *  2. Genuine agent echo reflections ARE still dropped
 *  3. Different-text messages pass through unaffected
 *  4. Chunked replies don't cause false drops of user messages matching a chunk
 */

type InboundDecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

const cfg = {} as OpenClawConfig;

function createParams(
  overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
    message?: Partial<InboundDecisionParams["message"]>;
  } = {},
): InboundDecisionParams {
  const { message: msgOverrides, ...restOverrides } = overrides;
  const message = {
    id: 100,
    is_from_me: false,
    is_group: false,
    sender: "+15551234567",
    text: "Hello",
    ...msgOverrides,
  };
  const messageText = restOverrides.messageText ?? message.text ?? "";
  const bodyText = restOverrides.bodyText ?? messageText;
  return {
    cfg,
    accountId: "default",
    opts: undefined,
    allowFrom: [],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    logVerbose: undefined,
    ...restOverrides,
    message,
    messageText,
    bodyText,
  };
}

describe("echo cache — message ID type canary (#47830)", () => {
  // Tests the implicit contract that outbound GUIDs (e.g. "p:0/abc-def-123")
  // Never match inbound SQLite row IDs (e.g. "200"). If iMessage ever changes
  // ID schemes, this test should break loudly.
  it("outbound GUID format and inbound SQLite row ID format never collide", () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    // Outbound messageId is a GUID format string
    echoCache.remember(scope, { messageId: "p:0/abc-def-123", text: "test" });

    // An inbound SQLite row ID (numeric string) should NOT match the GUID
    expect(echoCache.has(scope, { messageId: "200", text: "different" })).toBe(false);

    // The original GUID should still match
    expect(echoCache.has(scope, { messageId: "p:0/abc-def-123", text: "different" })).toBe(true);
  });

  it('falls back to text when outbound messageId was junk ("ok")', () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    // "ok" is normalized out and should not populate the ID cache.
    echoCache.remember(scope, { messageId: "ok", text: "text-only fallback" });

    // Inbound has a numeric SQLite ID that does not exist in cache. Since this
    // Scope has no real cached IDs, has() must still fall through to text match.
    expect(echoCache.has(scope, { messageId: "200", text: "text-only fallback" })).toBe(true);
  });

  it("keeps ID short-circuit when scope has real outbound GUID IDs", () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { messageId: "p:0/abc-def-123", text: "guid-backed" });

    // Different inbound numeric ID should still short-circuit to false.
    expect(echoCache.has(scope, { messageId: "200", text: "guid-backed" })).toBe(false);
  });
});

describe("echo cache — backward compat for channels without messageId", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Proves text-fallback echo detection still works when no messageId is present
  // On either side. Critical for backward compat with channels that don't
  // Populate messageId.
  it("text-only remember/has works within TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "no id message" });

    vi.advanceTimersByTime(2000);
    expect(echoCache.has(scope, { text: "no id message" })).toBe(true);
  });

  it("text-only has returns false after TTL expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "no id message" });

    vi.advanceTimersByTime(5000);
    expect(echoCache.has(scope, { text: "no id message" })).toBe(false);
  });

  it("text-only has returns false for different text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "no id message" });

    vi.advanceTimersByTime(1000);
    expect(echoCache.has(scope, { text: "totally different text" })).toBe(false);
  });
});

describe("self-chat dedupe — #47830", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT drop a user message that matches recently-sent agent text (self-chat scope collision)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    // Agent sends "Hello" to self-chat target +15551234567
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "agent-msg-1", text: "Hello" });

    // 2 seconds later, user sends "Hello" to themselves (different message id)
    vi.advanceTimersByTime(2000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello",
        echoCache,
        message: {
          id: 200,
          is_from_me: false,
          sender: "+15551234567",
          text: "Hello",
        },
        messageText: "Hello",
        selfChatCache,
      }),
    );

    // BUG: Before fix, this was "drop" reason "echo" — user message silently lost.
    // After fix: message-id mismatch means this is NOT an echo.
    // The echo cache should only match when message IDs match OR when text
    // Matches and no message ID is available on inbound.
    expect(decision.kind).toBe("dispatch");
  });

  it("DOES drop genuine agent echo (same message id reflected back)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();

    // Agent sends "Hello" to target
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "agent-msg-1", text: "Hello" });

    // 1 second later, iMessage reflects it back with same message id
    vi.advanceTimersByTime(1000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello",
        echoCache,
        message: {
          id: "agent-msg-1" as unknown as number,
          is_from_me: false,
          sender: "+15551234567",
          text: "Hello",
        },
        messageText: "Hello",
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
  });

  it("does NOT drop different-text messages even within TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();

    // Agent sends "Hello"
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "agent-msg-1", text: "Hello" });

    vi.advanceTimersByTime(1000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Goodbye",
        echoCache,
        message: {
          id: 201,
          is_from_me: false,
          sender: "+15551234567",
          text: "Goodbye",
        },
        messageText: "Goodbye",
      }),
    );

    expect(decision.kind).toBe("dispatch");
  });

  it("does NOT drop user messages that match a chunk of a multi-chunk agent reply", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15551234567";

    // Agent sends a multi-chunk reply: "Part one", "Part two", "Part three"
    echoCache.remember(scope, { messageId: "agent-chunk-1", text: "Part one" });
    echoCache.remember(scope, { messageId: "agent-chunk-2", text: "Part two" });
    echoCache.remember(scope, { messageId: "agent-chunk-3", text: "Part three" });

    vi.advanceTimersByTime(2000);

    // User sends "Part two" (matches chunk 2 text, but different message id)
    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Part two",
        echoCache,
        message: {
          id: 300,
          is_from_me: false,
          sender: "+15551234567",
          text: "Part two",
        },
        messageText: "Part two",
      }),
    );

    // Should NOT be dropped — different message id means not an echo
    expect(decision.kind).toBe("dispatch");
  });

  it("drops echo after text TTL expiry (4s TTL: expired at 5s)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    // Agent sends text (no message id available)
    echoCache.remember(scope, { text: "Hello there" });

    // After 5 seconds — beyond the 4s TTL, should NOT match
    vi.advanceTimersByTime(5000);

    const result = echoCache.has(scope, { text: "Hello there" });
    expect(result).toBe(false);
  });

  // Safe failure mode: TTL expiry causes duplicate delivery (noisy), never message loss (lossy)
  it("does NOT catch echo after TTL expiry — safe failure mode is duplicate delivery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15551234567";

    // Agent sends "Delayed echo test"
    echoCache.remember(scope, { messageId: "agent-msg-delayed", text: "Delayed echo test" });

    // 4.5 seconds later — beyond 4s TTL
    vi.advanceTimersByTime(4500);

    // Echo arrives with no messageId (text-only fallback path)
    const result = echoCache.has(scope, { text: "Delayed echo test" });

    // TTL expired → not caught → duplicate delivery (noisy but safe, not lossy)
    expect(result).toBe(false);
  });

  it("still drops text echo within 4s TTL window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "Hello there" });

    // After 3 seconds — within the 4s TTL, should still match
    vi.advanceTimersByTime(3000);

    const result = echoCache.has(scope, { text: "Hello there" });
    expect(result).toBe(true);
  });
});

describe("self-chat is_from_me=true handling (Bruce Phase 2 fix)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes real user self-chat message (is_from_me=true, no echo cache match)", () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello this is a test message",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          id: 123_703,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "Hello this is a test message",
        },
        messageText: "Hello this is a test message",
        selfChatCache,
      }),
    );

    expect(decision.kind).toBe("dispatch");
  });

  it("drops is_from_me outbound when destination_caller_id is blank and sender matches chat_identifier (#63980)", () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello this is a test message",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "",
          id: 123_704,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "Hello this is a test message",
        },
        messageText: "Hello this is a test message",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops DM false positives even when participant lists include the local handle", () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello from a normal DM row",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "me@icloud.com",
          id: 123_705,
          is_from_me: true,
          is_group: false,
          participants: ["+15551234567", "me@icloud.com"],
          sender: "+15551234567",
          text: "Hello from a normal DM row",
        },
        messageText: "Hello from a normal DM row",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops agent reply echo in self-chat (is_from_me=true, echo cache text match)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    // Agent sends "Hi there!" to self-chat
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "p:0/GUID-abc-def", text: "Hi there!" });

    // 1 second later, iMessage delivers the agent reply as is_from_me=true
    // With a SQLite row ID (never matches the GUID)
    vi.advanceTimersByTime(1000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hi there!",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          guid: "p:0/GUID-abc-def",
          id: 123_706,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "Hi there!",
        },
        messageText: "Hi there!",
        selfChatCache,
      }),
    );

    // Agent echo — should be dropped
    expect(decision).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
  });

  it("drops attachment-only agent echo in self-chat via bodyText placeholder", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "p:0/GUID-media", text: "<media:image>" });

    vi.advanceTimersByTime(1000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "<media:image>",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          guid: "p:0/GUID-media",
          id: 123_707,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "",
        },
        messageText: "",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
  });

  it("drops self-chat echo when outbound cache stored numeric id but inbound also carries a guid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "123709", text: "Numeric id echo" });

    vi.advanceTimersByTime(1000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Numeric id echo",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          guid: "p:0/GUID-different-shape",
          id: 123_709,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "Numeric id echo",
        },
        messageText: "Numeric id echo",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
  });

  it("does not drop a real self-chat image just because a recent agent image used the same placeholder", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "p:0/GUID-agent-image", text: "<media:image>" });

    vi.advanceTimersByTime(1000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "<media:image>",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          guid: "p:0/GUID-user-image",
          id: 123_708,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "",
        },
        messageText: "",
        selfChatCache,
      }),
    );

    expect(decision.kind).toBe("dispatch");
  });

  it("drops is_from_me=false reflection via selfChatCache (existing behavior preserved)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-24T12:00:00.000Z";

    // Step 1: is_from_me=true copy arrives (real user message) → processed, selfChatCache populated
    const first = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello",
        message: {
          chat_identifier: "+15551234567",
          created_at: createdAt,
          destination_caller_id: "+15551234567",
          id: 123_703,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "Hello",
        },
        messageText: "Hello",
        selfChatCache,
      }),
    );
    expect(first.kind).toBe("dispatch");

    // Step 2: is_from_me=false reflection arrives 2s later with same text+createdAt
    vi.advanceTimersByTime(2200);
    const second = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello",
        message: {
          chat_identifier: "+15551234567",
          created_at: createdAt,
          id: 123_704,
          is_from_me: false,
          is_group: false,
          sender: "+15551234567",
          text: "Hello",
        },
        messageText: "Hello",
        selfChatCache,
      }),
    );
    // Reflection correctly dropped
    expect(second).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("drops outbound DM when sender matches chat_identifier but destination_caller_id is absent (#63980)", () => {
    const selfChatCache = createSelfChatCache();

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "outbound",
        message: {
          chat_identifier: "+15550008888",
          id: 10_003,
          is_from_me: true,
          is_group: false,
          sender: "+15550008888",
          text: "outbound",
        },
        messageText: "outbound",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops reflected inbound when destination_caller_id is absent (#63980)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-24T12:00:00.000Z";

    const outbound = resolveIMessageInboundDecision(
      createParams({
        bodyText: "outbound",
        message: {
          chat_identifier: "+15550008888",
          created_at: createdAt,
          id: 10_003,
          is_from_me: true,
          is_group: false,
          sender: "+15550008888",
          text: "outbound",
        },
        messageText: "outbound",
        selfChatCache,
      }),
    );
    expect(outbound).toEqual({ kind: "drop", reason: "from me" });

    vi.advanceTimersByTime(2200);

    const reflection = resolveIMessageInboundDecision(
      createParams({
        bodyText: "outbound",
        message: {
          chat_identifier: "+15550008888",
          created_at: createdAt,
          id: 10_004,
          is_from_me: false,
          is_group: false,
          sender: "+15550008888",
          text: "outbound",
        },
        messageText: "outbound",
        selfChatCache,
      }),
    );

    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("normal DM is_from_me=true is still dropped (regression test)", () => {
    const selfChatCache = createSelfChatCache();

    // Normal DM with is_from_me=true: sender may be the local handle and
    // Chat_identifier the other party (they differ), so this is NOT self-chat.
    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Hello",
        message: {
          id: 9999,
          sender: "+15551234567", // Local user sent this
          chat_identifier: "+15555550123", // Sent TO this other person
          text: "Hello",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Hello",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("uses destination_caller_id to avoid DM self-chat false positives", () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    echoCache.remember("default:imessage:+15551234567", {
      messageId: "p:0/GUID-outbound",
      text: "Clean outbound text",
    });

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "�\u0001corrupted stored text",
        echoCache,
        message: {
          chat_identifier: "+15551234567",
          destination_caller_id: "+15550001111",
          id: 10_001,
          is_from_me: true,
          is_group: false,
          sender: "+15551234567",
          text: "�\u0001corrupted stored text",
        },
        messageText: "�\u0001corrupted stored text",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("echo cache text matching works with skipIdShortCircuit=true", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { messageId: "p:0/some-guid", text: "Cached reply" });

    vi.advanceTimersByTime(1000);

    // Text matches but ID is a SQLite row (format mismatch). With skipIdShortCircuit=true,
    // Text matching should still fire.
    expect(echoCache.has(scope, { messageId: "123799", text: "Cached reply" }, true)).toBe(true);

    // With skipIdShortCircuit=false (default), ID mismatch causes early return false.
    expect(echoCache.has(scope, { messageId: "123799", text: "Cached reply" }, false)).toBe(false);
  });
});

describe("echo cache — text fallback for null-id inbound messages", () => {
  it("still identifies echo via text when inbound message has id: null", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    // Agent sends "Sounds good" — no messageId available (edge case)
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Sounds good" });

    // 1 second later, inbound reflection arrives with id: null
    vi.advanceTimersByTime(1000);

    const decision = resolveIMessageInboundDecision(
      createParams({
        bodyText: "Sounds good",
        echoCache,
        message: {
          id: null as unknown as number,
          is_from_me: false,
          sender: "+15551234567",
          text: "Sounds good",
        },
        messageText: "Sounds good",
        selfChatCache,
      }),
    );

    // With id: null, the text-based fallback path is still active and should
    // Correctly identify this as an echo.
    expect(decision).toEqual({ kind: "drop", reason: "echo" });
  });
});

describe("echo cache — mixed GUID and text-only scopes", () => {
  it("still falls back to text for the latest text-only send in a scope with older GUID-backed sends", () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { messageId: "p:0/GUID-older", text: "older guid-backed" });
    echoCache.remember(scope, { messageId: "unknown", text: "latest text-only" });

    expect(echoCache.has(scope, { messageId: "200", text: "latest text-only" })).toBe(true);
  });

  it("still short-circuits when the latest copy of a text was GUID-backed", () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { messageId: "unknown", text: "same text" });
    echoCache.remember(scope, { messageId: "p:0/GUID-newer", text: "same text" });

    expect(echoCache.has(scope, { messageId: "200", text: "same text" })).toBe(false);
  });
});
