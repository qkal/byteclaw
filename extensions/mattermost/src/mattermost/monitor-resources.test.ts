import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMattermostChannel = vi.hoisted(() => vi.fn());
const fetchMattermostUser = vi.hoisted(() => vi.fn());
const sendMattermostTyping = vi.hoisted(() => vi.fn());
const updateMattermostPost = vi.hoisted(() => vi.fn());
const buildButtonProps = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  fetchMattermostChannel,
  fetchMattermostUser,
  sendMattermostTyping,
  updateMattermostPost,
}));

vi.mock("./interactions.js", () => ({
  buildButtonProps,
}));

describe("mattermost monitor resources", () => {
  let createMattermostMonitorResources: typeof import("./monitor-resources.js").createMattermostMonitorResources;

  beforeAll(async () => {
    ({ createMattermostMonitorResources } = await import("./monitor-resources.js"));
  });

  beforeEach(() => {
    fetchMattermostChannel.mockReset();
    fetchMattermostUser.mockReset();
    sendMattermostTyping.mockReset();
    updateMattermostPost.mockReset();
    buildButtonProps.mockReset();
  });

  it("downloads media, preserves auth headers, and infers media kind", async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    }));
    const saveMediaBuffer = vi.fn(async () => ({
      contentType: "image/png",
      path: "/tmp/file.png",
    }));

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client: {
        apiBaseUrl: "https://chat.example.com/api/v4",
        baseUrl: "https://chat.example.com",
        token: "bot-token",
      } as never,
      fetchRemoteMedia,
      logger: {},
      mediaKindFromMime: () => "image",
      mediaMaxBytes: 1024,
      saveMediaBuffer,
    });

    await expect(resources.resolveMattermostMedia([" file-1 "])).resolves.toEqual([
      {
        contentType: "image/png",
        kind: "image",
        path: "/tmp/file.png",
      },
    ]);

    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      filePathHint: "file-1",
      maxBytes: 1024,
      requestInit: {
        headers: {
          Authorization: "Bearer bot-token",
        },
      },
      ssrfPolicy: { allowedHostnames: ["chat.example.com"] },
      url: "https://chat.example.com/api/v4/files/file-1",
    });
  });

  it("caches channel and user lookups and falls back to empty picker props", async () => {
    fetchMattermostChannel.mockResolvedValue({ id: "chan-1", name: "town-square" });
    fetchMattermostUser.mockResolvedValue({ id: "user-1", username: "alice" });
    buildButtonProps.mockReturnValue(undefined);

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client: {} as never,
      fetchRemoteMedia: vi.fn(),
      logger: {},
      mediaKindFromMime: () => "document",
      mediaMaxBytes: 1024,
      saveMediaBuffer: vi.fn(),
    });

    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "town-square",
    });
    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "town-square",
    });
    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "alice",
    });
    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "alice",
    });

    expect(fetchMattermostChannel).toHaveBeenCalledTimes(1);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);

    await resources.updateModelPickerPost({
      channelId: "chan-1",
      message: "Pick a model",
      postId: "post-1",
    });

    expect(updateMattermostPost).toHaveBeenCalledWith(
      {},
      "post-1",
      expect.objectContaining({
        message: "Pick a model",
        props: { attachments: [] },
      }),
    );
  });

  it("proxies typing indicators to the mattermost client helper", async () => {
    const client = {} as never;

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client,
      fetchRemoteMedia: vi.fn(),
      logger: {},
      mediaKindFromMime: () => "document",
      mediaMaxBytes: 1024,
      saveMediaBuffer: vi.fn(),
    });

    await resources.sendTypingIndicator("chan-1", "root-1");
    expect(sendMattermostTyping).toHaveBeenCalledWith(client, {
      channelId: "chan-1",
      parentId: "root-1",
    });
  });
});
