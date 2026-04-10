import { describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

describe("createMatrixRoomMessageHandler thread root media", () => {
  it("keeps image-only thread roots visible via attachment markers", async () => {
    installMatrixMonitorTestRuntime();

    const formatAgentEnvelope = vi
      .fn()
      .mockImplementation((params: { body: string }) => params.body);
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixRoomMessageEvent({
            content: {
              msgtype: "m.image",
              body: "photo.jpg",
            } as never,
            eventId: "$thread-root",
            originServerTs: 123,
            sender: "@gum:matrix.example.org",
          }),
        getUserId: async () => "@bot:matrix.example.org",
      },
      formatAgentEnvelope,
      getMemberDisplayName: async () => "Gum",
      getRoomInfo: async () => ({
        altAliases: [],
        canonicalAlias: "#media:example.org",
        name: "Media Room",
      }),
      mediaMaxBytes: 5 * 1024 * 1024,
      replyToMode: "first",
      resolveAgentRoute: () => ({
        accountId: "ops",
        agentId: "main",
        channel: "matrix",
        mainSessionKey: "agent:main:main",
        matchedBy: "binding.account",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      }),
      resolveMarkdownTableMode: () => "code",
      resolveStorePath: () => "/tmp/openclaw-test-session.json",
      shouldHandleTextCommands: () => true,
      startupGraceMs: 60_000,
      startupMs: Date.now() - 120_000,
      textLimit: 4000,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "replying",
        eventId: "$reply",
        mentions: { user_ids: ["@bot:matrix.example.org"] },
        relatesTo: {
          event_id: "$thread-root",
          rel_type: "m.thread",
        },
        sender: "@bu:matrix.example.org",
      }),
    );

    expect(formatAgentEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("replying"),
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          ThreadStarterBody: expect.stringContaining("[matrix image attachment]"),
        }),
      }),
    );
  });
});
