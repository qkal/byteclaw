import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";

const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";

function createCtx(overrides?: Partial<MsgContext>): MsgContext {
  return {
    AccountId: "acc1",
    From: "+10000000001",
    Provider: "whatsapp",
    ...overrides,
  };
}

describe("sendTranscriptEcho", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "echo-1" }]);
  });

  it("sends the default formatted transcript to the resolved origin", async () => {
    await sendTranscriptEcho({
      cfg: {} as OpenClawConfig,
      ctx: createCtx(),
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      accountId: "acc1",
      bestEffort: true,
      cfg: {},
      channel: "whatsapp",
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      threadId: undefined,
      to: "+10000000001",
    });
  });

  it("uses a custom format when provided", async () => {
    await sendTranscriptEcho({
      cfg: {} as OpenClawConfig,
      ctx: createCtx(),
      format: "🎙️ Heard: {transcript}",
      transcript: "custom message",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "🎙️ Heard: custom message" }],
      }),
    );
  });

  it("skips non-deliverable channels", async () => {
    await sendTranscriptEcho({
      cfg: {} as OpenClawConfig,
      ctx: createCtx({ From: "some-source", Provider: "internal-system" }),
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no resolved destination", async () => {
    await sendTranscriptEcho({
      cfg: {} as OpenClawConfig,
      ctx: createCtx({ From: undefined, OriginatingTo: undefined }),
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("prefers OriginatingTo when From is absent", async () => {
    await sendTranscriptEcho({
      cfg: {} as OpenClawConfig,
      ctx: createCtx({ From: undefined, OriginatingTo: "+19999999999" }),
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+19999999999",
      }),
    );
  });

  it("swallows delivery failures", async () => {
    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    await expect(
      sendTranscriptEcho({
        cfg: {} as OpenClawConfig,
        ctx: createCtx(),
        transcript: "hello world",
      }),
    ).resolves.toBeUndefined();
  });
});
