import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import { sanitizeTerminalText } from "../../../../src/terminal/safe-text.js";
import {
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { createSelfChatCache } from "./self-chat-cache.js";

describe("resolveIMessageInboundDecision echo detection", () => {
  const cfg = {} as OpenClawConfig;
  type InboundDecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

  function createInboundDecisionParams(
    overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
      message?: Partial<InboundDecisionParams["message"]>;
    } = {},
  ): InboundDecisionParams {
    const { message: messageOverrides, ...restOverrides } = overrides;
    const message = {
      id: 42,
      is_from_me: false,
      is_group: false,
      sender: "+15555550123",
      text: "ok",
      ...messageOverrides,
    };
    const messageText = restOverrides.messageText ?? message.text ?? "";
    const bodyText = restOverrides.bodyText ?? messageText;
    const baseParams: Omit<InboundDecisionParams, "message" | "messageText" | "bodyText"> = {
      accountId: "default",
      allowFrom: [],
      cfg,
      dmPolicy: "open",
      echoCache: undefined,
      groupAllowFrom: [],
      groupHistories: new Map(),
      groupPolicy: "open",
      historyLimit: 0,
      logVerbose: undefined,
      opts: undefined,
      selfChatCache: undefined,
      storeAllowFrom: [],
    };
    return {
      ...baseParams,
      ...restOverrides,
      bodyText,
      message,
      messageText,
    };
  }

  function resolveDecision(
    overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
      message?: Partial<InboundDecisionParams["message"]>;
    } = {},
  ) {
    return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
  }

  it("drops inbound messages when outbound message id matches echo cache", () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => lookup.messageId === "42");

    const decision = resolveDecision({
      bodyText: "Reasoning:\n_step_",
      echoCache: { has: echoHas },
      message: {
        id: 42,
        text: "Reasoning:\n_step_",
      },
      messageText: "Reasoning:\n_step_",
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenNthCalledWith(1, "default:imessage:+15555550123", {
      messageId: "42",
    });
    expect(echoHas).toHaveBeenCalledTimes(1);
  });

  it("matches attachment-only echoes by bodyText placeholder", () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => lookup.text === "<media:image>" && lookup.messageId === "42");

    const decision = resolveDecision({
      bodyText: "<media:image>",
      echoCache: { has: echoHas },
      message: {
        id: 42,
        text: "",
      },
      messageText: "",
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenNthCalledWith(1, "default:imessage:+15555550123", {
      messageId: "42",
    });
    expect(echoHas).toHaveBeenNthCalledWith(
      2,
      "default:imessage:+15555550123",
      {
        messageId: "42",
        text: "<media:image>",
      },
      undefined,
    );
  });

  it("drops reflected self-chat duplicates after seeing the from-me copy", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveDecision({
        bodyText: "Do you want to report this issue?",
        message: {
          chat_identifier: "+15555550123",
          created_at: createdAt,
          destination_caller_id: "+15555550123",
          id: 9641,
          is_from_me: true,
          sender: "+15555550123",
          text: "Do you want to report this issue?",
        },
        messageText: "Do you want to report this issue?",
        selfChatCache,
      }),
    ).toMatchObject({ kind: "dispatch" });

    expect(
      resolveDecision({
        bodyText: "Do you want to report this issue?",
        message: {
          chat_identifier: "+15555550123",
          created_at: createdAt,
          id: 9642,
          sender: "+15555550123",
          text: "Do you want to report this issue?",
        },
        messageText: "Do you want to report this issue?",
        selfChatCache,
      }),
    ).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("does not drop same-text messages when created_at differs", () => {
    const selfChatCache = createSelfChatCache();

    resolveDecision({
      message: {
        created_at: "2026-03-02T20:58:10.649Z",
        id: 9641,
        is_from_me: true,
        text: "ok",
      },
      selfChatCache,
    });

    const decision = resolveDecision({
      message: {
        created_at: "2026-03-02T20:58:11.649Z",
        id: 9642,
        text: "ok",
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("keeps self-chat cache scoped to configured group threads", () => {
    const selfChatCache = createSelfChatCache();
    const groupedCfg = {
      channels: {
        imessage: {
          groups: {
            "123": {},
            "456": {},
          },
        },
      },
    } as OpenClawConfig;
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveDecision({
        cfg: groupedCfg,
        message: {
          chat_id: 123,
          created_at: createdAt,
          id: 9701,
          is_from_me: true,
          text: "same text",
        },
        selfChatCache,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    const decision = resolveDecision({
      cfg: groupedCfg,
      message: {
        chat_id: 456,
        created_at: createdAt,
        id: 9702,
        text: "same text",
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop other participants in the same group thread", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveDecision({
        message: {
          chat_id: 123,
          created_at: createdAt,
          id: 9751,
          is_from_me: true,
          is_group: true,
          text: "same text",
        },
        selfChatCache,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    const decision = resolveDecision({
      message: {
        chat_id: 123,
        created_at: createdAt,
        id: 9752,
        is_group: true,
        sender: "+15555550999",
        text: "same text",
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("sanitizes reflected duplicate previews before logging", () => {
    const selfChatCache = createSelfChatCache();
    const logVerbose = vi.fn();
    const createdAt = "2026-03-02T20:58:10.649Z";
    const bodyText = "line-1\nline-2\t\u001b[31mred";

    resolveDecision({
      bodyText,
      logVerbose,
      message: {
        chat_identifier: "+15555550123",
        created_at: createdAt,
        destination_caller_id: "+15555550123",
        id: 9801,
        is_from_me: true,
        sender: "+15555550123",
        text: bodyText,
      },
      messageText: bodyText,
      selfChatCache,
    });

    resolveDecision({
      bodyText,
      logVerbose,
      message: {
        chat_identifier: "+15555550123",
        created_at: createdAt,
        id: 9802,
        sender: "+15555550123",
        text: bodyText,
      },
      messageText: bodyText,
      selfChatCache,
    });

    expect(logVerbose).toHaveBeenCalledWith(
      `imessage: dropping self-chat reflected duplicate: "${sanitizeTerminalText(bodyText)}"`,
    );
  });
});

describe("describeIMessageEchoDropLog", () => {
  it("includes message id when available", () => {
    expect(
      describeIMessageEchoDropLog({
        messageId: "abc-123",
        messageText: "Reasoning:\n_step_",
      }),
    ).toContain("id=abc-123");
  });
});

describe("resolveIMessageInboundDecision command auth", () => {
  const cfg = {} as OpenClawConfig;
  const resolveDmCommandDecision = (params: { messageId: number; storeAllowFrom: string[] }) =>
    resolveIMessageInboundDecision({
      accountId: "default",
      allowFrom: [],
      bodyText: "/status",
      cfg,
      dmPolicy: "open",
      echoCache: undefined,
      groupAllowFrom: [],
      groupHistories: new Map(),
      groupPolicy: "open",
      historyLimit: 0,
      logVerbose: undefined,
      message: {
        id: params.messageId,
        is_from_me: false,
        is_group: false,
        sender: "+15555550123",
        text: "/status",
      },
      messageText: "/status",
      opts: undefined,
      storeAllowFrom: params.storeAllowFrom,
    });

  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const decision = resolveDmCommandDecision({
      messageId: 100,
      storeAllowFrom: [],
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(false);
  });

  it("authorizes DM commands for senders in pairing-store allowlist", () => {
    const decision = resolveDmCommandDecision({
      messageId: 101,
      storeAllowFrom: ["+15555550123"],
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(true);
  });
});
