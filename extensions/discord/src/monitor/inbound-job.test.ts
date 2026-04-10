import { Message } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import {
  buildDiscordInboundJob,
  materializeDiscordInboundJob,
  resolveDiscordInboundJobQueueKey,
} from "./inbound-job.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

describe("buildDiscordInboundJob", () => {
  it("prefers route session key, then base session key, then channel id for queueing", async () => {
    const routed = await createBaseDiscordMessageContext({
      baseSessionKey: "agent:main:discord:direct:base",
      messageChannelId: "channel-routed",
      route: { sessionKey: "agent:main:discord:direct:routed" },
    });
    const baseOnly = await createBaseDiscordMessageContext({
      baseSessionKey: "agent:main:discord:direct:base-only",
      messageChannelId: "channel-base",
      route: { sessionKey: "" },
    });
    const channelFallback = await createBaseDiscordMessageContext({
      baseSessionKey: "   ",
      messageChannelId: "channel-fallback",
      route: { sessionKey: "   " },
    });

    expect(resolveDiscordInboundJobQueueKey(routed)).toBe("agent:main:discord:direct:routed");
    expect(resolveDiscordInboundJobQueueKey(baseOnly)).toBe("agent:main:discord:direct:base-only");
    expect(resolveDiscordInboundJobQueueKey(channelFallback)).toBe("channel-fallback");
  });

  it("keeps live runtime references out of the payload", async () => {
    const ctx = await createBaseDiscordMessageContext({
      data: {
        guild: { id: "g1", name: "Guild" },
        message: {
          attachments: [],
          channel: {
            id: "thread-1",
            isThread: () => true,
          },
          channelId: "thread-1",
          id: "m1",
          timestamp: new Date().toISOString(),
        },
      },
      message: {
        attachments: [],
        channel: {
          id: "thread-1",
          isThread: () => true,
        },
        channelId: "thread-1",
        id: "m1",
        timestamp: new Date().toISOString(),
      },
      threadChannel: {
        id: "thread-1",
        name: "codex",
        ownerId: "user-1",
        parent: {
          id: "forum-1",
          name: "Forum",
        },
        parentId: "forum-1",
      },
    });

    const job = buildDiscordInboundJob(ctx);

    expect("runtime" in job.payload).toBe(false);
    expect("client" in job.payload).toBe(false);
    expect("threadBindings" in job.payload).toBe(false);
    expect("discordRestFetch" in job.payload).toBe(false);
    expect("channel" in job.payload.message).toBe(false);
    expect("channel" in job.payload.data.message).toBe(false);
    expect(job.runtime.client).toBe(ctx.client);
    expect(job.runtime.threadBindings).toBe(ctx.threadBindings);
    expect(job.payload.threadChannel).toEqual({
      id: "thread-1",
      name: "codex",
      ownerId: "user-1",
      parent: {
        id: "forum-1",
        name: "Forum",
      },
      parentId: "forum-1",
    });
    expect(() => JSON.stringify(job.payload)).not.toThrow();
  });

  it("re-materializes the process context with an overridden abort signal", async () => {
    const ctx = await createBaseDiscordMessageContext();
    const job = buildDiscordInboundJob(ctx);
    const overrideAbortController = new AbortController();

    const rematerialized = materializeDiscordInboundJob(job, overrideAbortController.signal);

    expect(rematerialized.runtime).toBe(ctx.runtime);
    expect(rematerialized.client).toBe(ctx.client);
    expect(rematerialized.threadBindings).toBe(ctx.threadBindings);
    expect(rematerialized.abortSignal).toBe(overrideAbortController.signal);
    expect(rematerialized.message).toEqual(job.payload.message);
    expect(rematerialized.data).toEqual(job.payload.data);
  });

  it("preserves Carbon message getters across queued jobs", async () => {
    const ctx = await createBaseDiscordMessageContext();
    const message = new Message(
      ctx.client as never,
      {
        attachments: [{ filename: "note.txt", id: "a1" }],
        author: {
          avatar: null,
          discriminator: "0",
          id: "u1",
          username: "alice",
        },
        channel_id: "c1",
        content: "hello",
        flags: 0,
        id: "m1",
        mention_everyone: false,
        pinned: false,
        referenced_message: {
          attachments: [],
          author: {
            avatar: null,
            discriminator: "0",
            id: "u2",
            username: "bob",
          },
          channel_id: "c1",
          content: "earlier",
          flags: 0,
          id: "m0",
          mention_everyone: false,
          pinned: false,
          timestamp: new Date().toISOString(),
          tts: false,
          type: 0,
        },
        timestamp: new Date().toISOString(),
        tts: false,
        type: 0,
      } as ConstructorParameters<typeof Message>[1],
    );
    const runtimeChannel = { id: "c1", isThread: () => false };
    Object.defineProperty(message, "channel", {
      configurable: true,
      enumerable: true,
      value: runtimeChannel,
      writable: true,
    });

    const job = buildDiscordInboundJob({
      ...ctx,
      data: {
        ...ctx.data,
        message,
      },
      message,
    });
    const rematerialized = materializeDiscordInboundJob(job);

    expect(job.payload.message).toBeInstanceOf(Message);
    expect("channel" in job.payload.message).toBe(false);
    expect(rematerialized.message.content).toBe("hello");
    expect(rematerialized.message.attachments).toHaveLength(1);
    expect(rematerialized.message.timestamp).toBe(message.timestamp);
    expect(rematerialized.message.referencedMessage?.content).toBe("earlier");
  });
});
