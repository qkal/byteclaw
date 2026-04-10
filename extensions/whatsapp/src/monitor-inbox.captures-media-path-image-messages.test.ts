import "./monitor-inbox.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getMonitorWebInbox,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
} from "./monitor-inbox.test-harness.js";
let monitorWebInbox: typeof import("./inbound.js").monitorWebInbox;
const inboundLoggerInfoMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/text-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/text-runtime")>(
    "openclaw/plugin-sdk/text-runtime",
  );
  return {
    ...actual,
    getChildLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: inboundLoggerInfoMock,
      warn: vi.fn(),
    }),
  };
});

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  beforeEach(() => {
    inboundLoggerInfoMock.mockReset();
    monitorWebInbox = getMonitorWebInbox();
  });

  async function openMonitor(onMessage = vi.fn()) {
    return await monitorWebInbox({
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      verbose: false,
    });
  }

  async function runSingleUpsertAndCapture(upsert: unknown) {
    const onMessage = vi.fn();
    const listener = await openMonitor(onMessage);
    const sock = getSock();
    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { listener, onMessage, sock };
  }

  function expectSingleGroupMessage(
    onMessage: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ) {
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining(expected));
  }

  it("captures media path for image messages", async () => {
    const { onMessage, listener, sock } = await runSingleUpsertAndCapture({
      messages: [
        {
          key: { fromMe: false, id: "med1", remoteJid: "888@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_100,
        },
      ],
      type: "notify",
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "<media:image>",
      }),
    );
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        fromMe: false,
        id: "med1",
        participant: undefined,
        remoteJid: "888@s.whatsapp.net",
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "available");
    await listener.close();
  });

  it("sets gifPlayback on outbound video payloads when requested", async () => {
    const onMessage = vi.fn();
    const listener = await openMonitor(onMessage);
    const sock = getSock();
    const buf = Buffer.from("gifvid");

    await listener.sendMessage("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });

    expect(sock.sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      caption: "gif",
      gifPlayback: true,
      mimetype: "video/mp4",
      video: buf,
    });

    await listener.close();
  });

  it("resolves onClose when the socket closes", async () => {
    const listener = await openMonitor(vi.fn());
    const sock = getSock();
    const reasonPromise = listener.onClose;
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await expect(reasonPromise).resolves.toEqual(
      expect.objectContaining({ isLoggedOut: false, status: 500 }),
    );
    await listener.close();
  });

  it("detaches inbound listeners and closes the socket on close()", async () => {
    const listener = await openMonitor(vi.fn());
    const sock = getSock();

    expect(sock.ev.listenerCount("messages.upsert")).toBeGreaterThan(0);
    expect(sock.ev.listenerCount("connection.update")).toBeGreaterThan(0);

    await listener.close();

    expect(sock.ev.listenerCount("messages.upsert")).toBe(0);
    expect(sock.ev.listenerCount("connection.update")).toBe(0);
    expect(sock.ws.close).toHaveBeenCalledTimes(1);
  });

  it("logs inbound bodies through the inbound child logger", async () => {
    const { listener } = await runSingleUpsertAndCapture({
      messages: [
        {
          key: { fromMe: false, id: "abc", remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
      type: "notify",
    });

    expect(inboundLoggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "ping",
        from: "+999",
      }),
      "inbound message",
    );
    await listener.close();
  });

  it("includes participant when marking group messages read", async () => {
    const { listener, sock } = await runSingleUpsertAndCapture({
      messages: [
        {
          key: {
            fromMe: false,
            id: "grp1",
            participant: "111@s.whatsapp.net",
            remoteJid: "12345-67890@g.us",
          },
          message: { conversation: "group ping" },
        },
      ],
      type: "notify",
    });

    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        fromMe: false,
        id: "grp1",
        participant: "111@s.whatsapp.net",
        remoteJid: "12345-67890@g.us",
      },
    ]);
    await listener.close();
  });

  it("passes through group messages with participant metadata", async () => {
    const { onMessage, listener } = await runSingleUpsertAndCapture({
      messages: [
        {
          key: {
            fromMe: false,
            id: "grp2",
            participant: "777@s.whatsapp.net",
            remoteJid: "99999@g.us",
          },
          message: {
            extendedTextMessage: {
              contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
              text: "@bot ping",
            },
          },
          messageTimestamp: 1_700_000_000,
          pushName: "Alice",
        },
      ],
      type: "notify",
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: "group",
        conversationId: "99999@g.us",
        mentionedJids: ["123@s.whatsapp.net"],
        senderE164: "+777",
      }),
    );
    await listener.close();
  });

  it("unwraps ephemeral messages, preserves mentions, and still delivers group pings", async () => {
    const { onMessage, listener } = await runSingleUpsertAndCapture({
      messages: [
        {
          key: {
            fromMe: false,
            id: "grp-ephem",
            participant: "888@s.whatsapp.net",
            remoteJid: "424242@g.us",
          },
          message: {
            ephemeralMessage: {
              message: {
                extendedTextMessage: {
                  contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
                  text: "oh hey @Clawd UK !",
                },
              },
            },
          },
        },
      ],
      type: "notify",
    });
    expectSingleGroupMessage(onMessage, {
      body: "oh hey @Clawd UK !",
      chatType: "group",
      conversationId: "424242@g.us",
      mentionedJids: ["123@s.whatsapp.net"],
      senderE164: "+888",
    });
    await listener.close();
  });

  it("still forwards group messages (with sender info) even when allowFrom is restrictive", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // Does not include +777
          allowFrom: ["+111"],
          groupPolicy: "open",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const { onMessage, listener } = await runSingleUpsertAndCapture({
      messages: [
        {
          key: {
            fromMe: false,
            id: "grp-allow",
            participant: "777@s.whatsapp.net",
            remoteJid: "55555@g.us",
          },
          message: {
            extendedTextMessage: {
              contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
              text: "@bot hi",
            },
          },
        },
      ],
      type: "notify",
    });
    expectSingleGroupMessage(onMessage, {
      chatType: "group",
      from: "55555@g.us",
      mentionedJids: ["123@s.whatsapp.net"],
      selfE164: "+123",
      selfJid: "123@s.whatsapp.net",
      senderE164: "+777",
      senderJid: "777@s.whatsapp.net",
    });
    await listener.close();
  });
});
