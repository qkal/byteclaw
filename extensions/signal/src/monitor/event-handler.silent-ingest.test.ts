import { describe, expect, it, vi } from "vitest";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      action,
      context,
      messages: [],
      sessionKey,
      timestamp: new Date(),
      type,
    }),
  ),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

import { createSignalEventHandler } from "./event-handler.js";

describe("signal mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          channels: {
            signal: {
              groups: {
                "*": {
                  ingest: true,
                  requireMention: true,
                },
              },
            },
          },
          messages: {
            groupChat: { mentionPatterns: ["@bot"] },
          },
        } as never,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          groupInfo: { groupId: "group-123", groupName: "Ops" },
          message: "hello without mention",
        },
      }),
    );

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("signal"),
      expect.objectContaining({
        channelId: "signal",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not emit when group ingest is false and wildcard ingest is true", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          channels: {
            signal: {
              groups: {
                "*": {
                  ingest: true,
                  requireMention: true,
                },
                "group-123": {
                  ingest: false,
                  requireMention: true,
                },
              },
            },
          },
          messages: {
            groupChat: { mentionPatterns: ["@bot"] },
          },
        } as never,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          groupInfo: { groupId: "group-123", groupName: "Ops" },
          message: "hello without mention",
        },
      }),
    );

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });
});
