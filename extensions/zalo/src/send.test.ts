import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.fn();
const sendPhotoMock = vi.fn();
const resolveZaloProxyFetchMock = vi.fn();

vi.mock("./api.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  sendPhoto: (...args: unknown[]) => sendPhotoMock(...args),
}));

vi.mock("./proxy.js", () => ({
  resolveZaloProxyFetch: (...args: unknown[]) => resolveZaloProxyFetchMock(...args),
}));

import { sendMessageZalo, sendPhotoZalo } from "./send.js";

describe("zalo send", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendPhotoMock.mockReset();
    resolveZaloProxyFetchMock.mockReset();
    resolveZaloProxyFetchMock.mockReturnValue(undefined);
  });

  it("sends text messages through the message API", async () => {
    sendMessageMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-msg-1" },
    });

    const result = await sendMessageZalo("dm-chat-1", "hello there", {
      token: "zalo-token",
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-1",
        text: "hello there",
      },
      undefined,
    );
    expect(sendPhotoMock).not.toHaveBeenCalled();
    expect(result).toEqual({ messageId: "z-msg-1", ok: true });
  });

  it("routes media-bearing sends through the photo API and uses text as caption", async () => {
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-1" },
    });

    const result = await sendMessageZalo("dm-chat-2", "caption text", {
      caption: "ignored fallback caption",
      mediaUrl: "https://example.com/photo.jpg",
      token: "zalo-token",
    });

    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        caption: "caption text",
        chat_id: "dm-chat-2",
        photo: "https://example.com/photo.jpg",
      },
      undefined,
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(result).toEqual({ messageId: "z-photo-1", ok: true });
  });

  it("fails fast for missing token or blank photo URLs", async () => {
    await expect(sendMessageZalo("dm-chat-3", "hello", {})).resolves.toEqual({
      error: "No Zalo bot token configured",
      ok: false,
    });

    await expect(
      sendPhotoZalo("dm-chat-4", "   ", {
        token: "zalo-token",
      }),
    ).resolves.toEqual({
      error: "No photo URL provided",
      ok: false,
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendPhotoMock).not.toHaveBeenCalled();
  });
});
