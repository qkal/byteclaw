import { ChannelType } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscordRest } from "./send.test-harness.js";

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ session: { dmScope: "main" } })));

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: (..._args: unknown[]) => loadConfigMock(),
  };
});

vi.mock("./components-registry.js", () => ({
  registerDiscordComponentEntries: vi.fn(),
}));

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
vi.mock("./send.outbound.js", () => ({
  sendMessageDiscord: sendMessageDiscordMock,
}));

const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
vi.mock("./runtime-api.js", () => ({
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));

let registerDiscordComponentEntries: typeof import("./components-registry.js").registerDiscordComponentEntries;
let editDiscordComponentMessage: typeof import("./send.components.js").editDiscordComponentMessage;
let registerBuiltDiscordComponentMessage: typeof import("./send.components.js").registerBuiltDiscordComponentMessage;
let sendDiscordComponentMessage: typeof import("./send.components.js").sendDiscordComponentMessage;

function resetClassicMocks(): void {
  sendMessageDiscordMock.mockReset();
  sendMessageDiscordMock.mockResolvedValue({ channelId: "chan-1", messageId: "msg1" });
  loadOutboundMediaFromUrlMock.mockReset();
  loadOutboundMediaFromUrlMock.mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "report.pdf",
  });
  vi.clearAllMocks();
}

describe("sendDiscordComponentMessage", () => {
  let registerMock: ReturnType<typeof vi.mocked<typeof registerDiscordComponentEntries>>;

  beforeAll(async () => {
    ({ registerDiscordComponentEntries } = await import("./components-registry.js"));
    ({
      editDiscordComponentMessage,
      registerBuiltDiscordComponentMessage,
      sendDiscordComponentMessage,
    } = await import("./send.components.js"));
  });

  beforeEach(() => {
    registerMock = vi.mocked(registerDiscordComponentEntries);
    resetClassicMocks();
  });

  it("keeps direct-channel DM session keys on component entries", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      recipients: [{ id: "user-1" }],
      type: ChannelType.DM,
    });
    postMock.mockResolvedValueOnce({ channel_id: "dm-1", id: "msg1" });

    await sendDiscordComponentMessage(
      "channel:dm-1",
      {
        blocks: [{ buttons: [{ label: "Tap" }], type: "actions" }],
      },
      {
        agentId: "main",
        rest,
        sessionKey: "agent:main:discord:channel:dm-1",
        token: "t",
      },
    );

    expect(registerMock).toHaveBeenCalledTimes(1);
    const args = registerMock.mock.calls[0]?.[0];
    expect(args?.entries[0]?.sessionKey).toBe("agent:main:discord:channel:dm-1");
  });

  it("edits component messages and refreshes component registry entries", async () => {
    const { rest, patchMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      id: "chan-1",
      type: ChannelType.GuildText,
    });
    patchMock.mockResolvedValueOnce({ channel_id: "chan-1", id: "msg1" });

    await editDiscordComponentMessage(
      "channel:chan-1",
      "msg1",
      {
        blocks: [{ buttons: [{ label: "Tap" }], type: "actions" }],
        text: "Updated picker",
      },
      {
        agentId: "main",
        rest,
        sessionKey: "agent:main:discord:channel:chan-1",
        token: "t",
      },
    );

    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining("/channels/chan-1/messages/msg1"),
      expect.objectContaining({
        body: expect.any(Object),
      }),
    );
    expect(registerMock).toHaveBeenCalledTimes(1);
    const args = registerMock.mock.calls[0]?.[0];
    expect(args?.messageId).toBe("msg1");
    expect(args?.entries[0]?.sessionKey).toBe("agent:main:discord:channel:chan-1");
  });

  it("registers a prebuilt component message against an edited message id", () => {
    registerBuiltDiscordComponentMessage({
      buildResult: {
        components: [],
        entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
        modals: [{ fields: [], id: "modal-1", title: "Modal" }],
      },
      messageId: "msg1",
    });

    expect(registerMock).toHaveBeenCalledWith({
      entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
      messageId: "msg1",
      modals: [{ fields: [], id: "modal-1", title: "Modal" }],
    });
  });
});

describe("sendDiscordComponentMessage classic message downgrade", () => {
  beforeEach(() => {
    resetClassicMocks();
  });

  it("forwards mediaReadFile and mediaAccess to sendMessageDiscord", async () => {
    const readFileMock = vi.fn().mockResolvedValue(Buffer.from("pdf"));
    const mediaAccess = { localRoots: ["/tmp"], readFile: readFileMock };

    await sendDiscordComponentMessage(
      "channel:chan-1",
      { blocks: [{ text: "report", type: "text" }] },
      {
        mediaAccess,
        mediaReadFile: readFileMock,
        mediaUrl: "https://example.com/report.pdf",
        token: "t",
      },
    );

    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:chan-1",
      "report",
      expect.objectContaining({
        mediaAccess,
        mediaReadFile: readFileMock,
      }),
    );
  });

  it("keeps modal component messages on the component path", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    const registerMock = vi.mocked(registerDiscordComponentEntries);
    getMock.mockResolvedValueOnce({
      id: "chan-1",
      type: ChannelType.GuildText,
    });
    postMock.mockResolvedValueOnce({ channel_id: "chan-1", id: "msg1" });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        modal: {
          fields: [{ label: "Notes", type: "text" }],
          title: "Feedback",
        },
        text: "report",
      },
      {
        mediaUrl: "https://example.com/report.pdf",
        rest,
        token: "t",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modals: [expect.objectContaining({ title: "Feedback" })],
      }),
    );
  });

  it("keeps spoiler file blocks on the component path", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      id: "chan-1",
      type: ChannelType.GuildText,
    });
    postMock.mockResolvedValueOnce({ channel_id: "chan-1", id: "msg1" });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        blocks: [{ file: "attachment://report.pdf", spoiler: true, type: "file" }],
        text: "report",
      },
      {
        mediaUrl: "https://example.com/report.pdf",
        rest,
        token: "t",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("keeps container-styled messages on the component path", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      id: "chan-1",
      type: ChannelType.GuildText,
    });
    postMock.mockResolvedValueOnce({ channel_id: "chan-1", id: "msg1" });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        container: {
          accentColor: 0x00ff00,
        },
        text: "report",
      },
      {
        mediaUrl: "https://example.com/report.pdf",
        rest,
        token: "t",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});
