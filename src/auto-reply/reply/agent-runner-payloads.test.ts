import { describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";

const baseParams = {
  blockReplyPipeline: null,
  blockStreamingEnabled: false,
  didLogHeartbeatStrip: false,
  isHeartbeat: false,
  replyToMode: "off" as const,
};

async function expectSameTargetRepliesSuppressed(params: { provider: string; to: string }) {
  const { replyPayloads } = await buildReplyPayloads({
    ...baseParams,
    messageProvider: "heartbeat",
    messagingToolSentTargets: [{ provider: params.provider, to: params.to, tool: "message" }],
    messagingToolSentTexts: ["different message"],
    originatingChannel: "feishu",
    originatingTo: "ou_abc123",
    payloads: [{ text: "hello world!" }],
  });

  expect(replyPayloads).toHaveLength(0);
}

describe("buildReplyPayloads media filter integration", () => {
  it("strips media URL from payload when in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      payloads: [{ mediaUrl: "file:///tmp/photo.jpg", text: "hello" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBeUndefined();
  });

  it("preserves media URL when not in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      messagingToolSentMediaUrls: ["file:///tmp/other.jpg"],
      payloads: [{ mediaUrl: "file:///tmp/photo.jpg", text: "hello" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("normalizes sent media URLs before deduping normalized reply media", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string; mediaUrls?: string[] }) => {
      const normalizeMedia = (value?: string) =>
        value === "./out/photo.jpg" ? "/tmp/workspace/out/photo.jpg" : value;
      return {
        ...payload,
        mediaUrl: normalizeMedia(payload.mediaUrl),
        mediaUrls: payload.mediaUrls?.map((value) => normalizeMedia(value) ?? value),
      };
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      messagingToolSentMediaUrls: ["./out/photo.jpg"],
      normalizeMediaPaths,
      payloads: [{ mediaUrl: "./out/photo.jpg", text: "hello" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
      text: "hello",
    });
  });

  it("drops only invalid media when reply media normalization fails", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string }) => {
      if (payload.mediaUrl === "./bad.png") {
        throw new Error("Path escapes sandbox root");
      }
      return payload;
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      normalizeMediaPaths,
      payloads: [
        { audioAsVoice: true, mediaUrl: "./bad.png", text: "keep text" },
        { text: "keep second" },
      ],
    });

    expect(replyPayloads).toHaveLength(2);
    expect(replyPayloads[0]).toMatchObject({
      audioAsVoice: false,
      mediaUrl: undefined,
      mediaUrls: undefined,
      text: "keep text",
    });
    expect(replyPayloads[1]).toMatchObject({
      text: "keep second",
    });
  });

  it("applies media filter after text filter", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      messagingToolSentTexts: ["hello world!"],
      payloads: [{ mediaUrl: "file:///tmp/photo.jpg", text: "hello world!" }],
    });

    // Text filter removes the payload entirely (text matched), so nothing remains.
    expect(replyPayloads).toHaveLength(0);
  });

  it("does not dedupe text for cross-target messaging sends", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      messageProvider: "telegram",
      messagingToolSentTargets: [{ provider: "discord", to: "channel:C1", tool: "discord" }],
      messagingToolSentTexts: ["hello world!"],
      originatingTo: "telegram:123",
      payloads: [{ text: "hello world!" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });

  it("does not dedupe media for cross-target messaging sends", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      messageProvider: "telegram",
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      messagingToolSentTargets: [{ provider: "slack", to: "channel:C1", tool: "slack" }],
      originatingTo: "telegram:123",
      payloads: [{ mediaUrl: "file:///tmp/photo.jpg", text: "photo" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("suppresses same-target replies when messageProvider is synthetic but originatingChannel is set", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      messageProvider: "heartbeat",
      messagingToolSentTargets: [{ provider: "telegram", to: "268300329", tool: "telegram" }],
      messagingToolSentTexts: ["different message"],
      originatingChannel: "telegram",
      originatingTo: "268300329",
      payloads: [{ text: "hello world!" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("suppresses same-target replies when message tool target provider is generic", async () => {
    await expectSameTargetRepliesSuppressed({ provider: "message", to: "ou_abc123" });
  });

  it("suppresses same-target replies when target provider is channel alias", async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            capabilities: { chatTypes: ["direct"] },
            config: { listAccountIds: () => [], resolveAccount: () => ({}) },
            id: "feishu",
            meta: {
              aliases: ["lark"],
              blurb: "test stub",
              docsPath: "/channels/feishu",
              id: "feishu",
              label: "Feishu",
              selectionLabel: "Feishu",
            },
          },
          pluginId: "feishu-plugin",
          source: "test",
        },
      ]),
    );
    await expectSameTargetRepliesSuppressed({ provider: "lark", to: "ou_abc123" });
  });

  it("drops all final payloads when block pipeline streamed successfully", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      enqueue: () => {},
      flush: async () => {},
      hasBuffered: () => false,
      hasSentPayload: () => false,
      isAborted: () => false,
      stop: () => {},
    };
    // ShouldDropFinalPayloads short-circuits to [] when the pipeline streamed
    // Without aborting, so hasSentPayload is never reached.
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockReplyPipeline: pipeline,
      blockStreamingEnabled: true,
      payloads: [{ replyToId: "post-123", text: "response" }],
      replyToMode: "all",
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("drops all final payloads during silent turns, including media-only payloads", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ mediaUrl: "file:///tmp/photo.jpg", text: "NO_REPLY" }],
      silentExpected: true,
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("deduplicates final payloads against directly sent block keys regardless of replyToId", async () => {
    // When block streaming is not active but directlySentBlockKeys has entries
    // (e.g. from pre-tool flush), the key should match even if replyToId differs.
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>();
    directlySentBlockKeys.add(
      createBlockReplyContentKey({ replyToId: "post-1", text: "response" }),
    );

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      directlySentBlockKeys,
      payloads: [{ text: "response" }],
      replyToMode: "off",
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("does not suppress same-target replies when accountId differs", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      accountId: "personal",
      messageProvider: "heartbeat",
      messagingToolSentTargets: [
        {
          accountId: "work",
          provider: "telegram",
          to: "268300329",
          tool: "telegram",
        },
      ],
      messagingToolSentTexts: ["different message"],
      originatingChannel: "telegram",
      originatingTo: "268300329",
      payloads: [{ text: "hello world!" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });
});
