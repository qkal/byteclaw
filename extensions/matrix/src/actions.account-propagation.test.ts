import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessageActionContext } from "../runtime-api.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleMatrixAction: vi.fn(),
}));

vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: mocks.handleMatrixAction,
}));

const { matrixMessageActions } = await import("./actions.js");

const profileAction = "set-profile" as ChannelMessageActionContext["action"];

function createContext(
  overrides: Partial<ChannelMessageActionContext>,
): ChannelMessageActionContext {
  return {
    action: "send",
    cfg: {
      channels: {
        matrix: {
          accessToken: "token",
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
      },
    } as CoreConfig,
    channel: "matrix",
    params: {},
    ...overrides,
  };
}

describe("matrixMessageActions account propagation", () => {
  beforeEach(() => {
    mocks.handleMatrixAction.mockReset().mockResolvedValue({
      details: { ok: true },
      ok: true,
      output: "",
    });
  });

  it("forwards accountId for send actions", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        accountId: "ops",
        action: "send",
        params: {
          message: "hello",
          to: "room:!room:example",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        action: "sendMessage",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards accountId for permissions actions", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        accountId: "ops",
        action: "permissions",
        params: {
          operation: "verification-list",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        action: "verificationList",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards accountId for self-profile updates", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        accountId: "ops",
        action: profileAction,
        params: {
          avatarUrl: "mxc://example/avatar",
          displayName: "Ops Bot",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        action: "setProfile",
        avatarUrl: "mxc://example/avatar",
        displayName: "Ops Bot",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards local avatar paths for self-profile updates", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        accountId: "ops",
        action: profileAction,
        params: {
          path: "/tmp/avatar.jpg",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        action: "setProfile",
        avatarPath: "/tmp/avatar.jpg",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards mediaLocalRoots for media sends", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        accountId: "ops",
        action: "send",
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
        params: {
          media: "file:///tmp/photo.png",
          message: "hello",
          to: "room:!room:example",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        action: "sendMessage",
        mediaUrl: "file:///tmp/photo.png",
      }),
      expect.any(Object),
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );
  });

  it("allows media-only sends without requiring a message body", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        accountId: "ops",
        action: "send",
        params: {
          media: "file:///tmp/photo.png",
          to: "room:!room:example",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        action: "sendMessage",
        content: undefined,
        mediaUrl: "file:///tmp/photo.png",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("accepts shared media aliases and forwards voice-send intent", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        accountId: "ops",
        action: "send",
        params: {
          asVoice: true,
          filePath: "/tmp/clip.mp3",
          to: "room:!room:example",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        action: "sendMessage",
        audioAsVoice: true,
        content: undefined,
        mediaUrl: "/tmp/clip.mp3",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });
});
