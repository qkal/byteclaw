import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  monitorWebChannelWithCapture,
  sendWebDirectInboundAndCollectSessionKeys,
} from "./auto-reply.broadcast-groups.test-harness.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();

  it("skips unknown broadcast agent ids when agents.list is present", async () => {
    setLoadConfigMock({
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "+1000": ["alfred", "missing"],
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } satisfies OpenClawConfig);

    const { seen, resolver } = await sendWebDirectInboundAndCollectSessionKeys();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen[0]).toContain("agent:alfred:");
    resetLoadConfigMock();
  });

  it("broadcasts sequentially in configured order", async () => {
    setLoadConfigMock({
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        "+1000": ["alfred", "baerbel"],
        strategy: "sequential",
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } satisfies OpenClawConfig);

    const { seen, resolver } = await sendWebDirectInboundAndCollectSessionKeys();

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(seen[0]).toContain("agent:alfred:");
    expect(seen[1]).toContain("agent:baerbel:");
    resetLoadConfigMock();
  });

  it("shares group history across broadcast agents and clears after replying", async () => {
    setLoadConfigMock({
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        "123@g.us": ["alfred", "baerbel"],
        strategy: "sequential",
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } satisfies OpenClawConfig);

    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);

    await sendWebGroupInboundMessage({
      body: "hello group",
      id: "g1",
      onMessage,
      selfE164: "+999",
      senderE164: "+111",
      senderName: "Alice",
      spies,
    });

    expect(resolver).not.toHaveBeenCalled();

    await sendWebGroupInboundMessage({
      body: "@bot ping",
      id: "g2",
      mentionedJids: ["999@s.whatsapp.net"],
      onMessage,
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      senderE164: "+222",
      senderName: "Bob",
      spies,
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    for (const call of resolver.mock.calls.slice(0, 2)) {
      const payload = call[0] as {
        Body: string;
        SenderName?: string;
        SenderE164?: string;
        SenderId?: string;
      };
      expect(payload.Body).toContain("Chat messages since your last reply");
      expect(payload.Body).toContain("Alice (+111): hello group");
      expect(payload.Body).not.toContain("[message_id:");
      expect(payload.Body).toContain("@bot ping");
      expect(payload.SenderName).toBe("Bob");
      expect(payload.SenderE164).toBe("+222");
      expect(payload.SenderId).toBe("+222");
    }

    await sendWebGroupInboundMessage({
      body: "@bot ping 2",
      id: "g3",
      mentionedJids: ["999@s.whatsapp.net"],
      onMessage,
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      senderE164: "+333",
      senderName: "Clara",
      spies,
    });

    expect(resolver).toHaveBeenCalledTimes(4);
    for (const call of resolver.mock.calls.slice(2, 4)) {
      const payload = call[0] as { Body: string };
      expect(payload.Body).not.toContain("Alice (+111): hello group");
      expect(payload.Body).not.toContain("Chat messages since your last reply");
    }

    resetLoadConfigMock();
  });

  it("broadcasts in parallel by default", async () => {
    setLoadConfigMock({
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        "+1000": ["alfred", "baerbel"],
        strategy: "parallel",
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } satisfies OpenClawConfig);

    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();

    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const resolver = vi.fn(async () => {
      started += 1;
      if (started < 2) {
        await gate;
      } else {
        release?.();
      }
      return { text: "ok" };
    });

    const { onMessage: capturedOnMessage } = await monitorWebChannelWithCapture(resolver);

    await capturedOnMessage({
      accountId: "default",
      body: "hello",
      chatId: "direct:+1000",
      chatType: "direct",
      conversationId: "+1000",
      from: "+1000",
      id: "m1",
      reply,
      sendComposing,
      sendMedia,
      timestamp: Date.now(),
      to: "+2000",
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    resetLoadConfigMock();
  });
});
