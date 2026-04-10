import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";

type DeliverMattermostReplyPayloadParams = Parameters<typeof deliverMattermostReplyPayload>[0];
type ReplyDeliveryMarkdownTableMode = Parameters<
  DeliverMattermostReplyPayloadParams["core"]["channel"]["text"]["convertMarkdownTables"]
>[1];

function createReplyDeliveryCore(): DeliverMattermostReplyPayloadParams["core"] {
  return {
    channel: {
      text: {
        chunkByNewline: vi.fn((text: string) => [text]),
        chunkMarkdownText: vi.fn((text: string) => [text]),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        chunkText: vi.fn((text: string) => [text]),
        chunkTextWithMode: vi.fn((text: string) => [text]),
        convertMarkdownTables: vi.fn((text: string) => text),
        hasControlCommand: vi.fn(() => false),
        resolveChunkMode: vi.fn<() => ChunkMode>(() => "length"),
        resolveMarkdownTableMode: vi.fn<() => ReplyDeliveryMarkdownTableMode>(() => "off"),
        resolveTextChunkLimit: vi.fn(
          (
            _cfg: OpenClawConfig | undefined,
            _provider?: string,
            _accountId?: string | null,
            opts?: { fallbackLimit?: number },
          ) => opts?.fallbackLimit ?? 4000,
        ),
      },
    },
  } as unknown as PluginRuntime;
}

describe("deliverMattermostReplyPayload", () => {
  it("passes agent-scoped mediaLocalRoots when sending media paths", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sendMessage = vi.fn(async () => undefined);
      const core = createReplyDeliveryCore();

      const agentId = "agent-1";
      const mediaUrl = `file://${path.join(stateDir, `workspace-${agentId}`, "photo.png")}`;
      const cfg = {} satisfies OpenClawConfig;

      await deliverMattermostReplyPayload({
        accountId: "default",
        agentId,
        cfg,
        core,
        payload: { mediaUrl, text: "caption" },
        replyToId: "root-post",
        sendMessage,
        tableMode: "off",
        textLimit: 4000,
        to: "channel:town-square",
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel:town-square",
        "caption",
        expect.objectContaining({
          accountId: "default",
          cfg,
          mediaLocalRoots: expect.arrayContaining([path.join(stateDir, `workspace-${agentId}`)]),
          mediaUrl,
          replyToId: "root-post",
        }),
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("forwards replyToId for text-only chunked replies", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => ["hello"]);

    await deliverMattermostReplyPayload({
      accountId: "default",
      agentId: "agent-1",
      cfg,
      core,
      payload: { text: "hello" },
      replyToId: "root-post",
      sendMessage,
      tableMode: "off",
      textLimit: 4000,
      to: "channel:town-square",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      "hello",
      expect.objectContaining({
        accountId: "default",
        cfg,
        replyToId: "root-post",
      }),
    );
  });
});
