import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import { downloadBlueBubblesAttachment, sendBlueBubblesAttachment } from "./attachments.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import type { PluginRuntime } from "./runtime-api.js";
import { setBlueBubblesRuntime } from "./runtime.js";
import {
  BLUE_BUBBLES_PRIVATE_API_STATUS,
  installBlueBubblesFetchTestHooks,
  mockBlueBubblesPrivateApiStatus,
  mockBlueBubblesPrivateApiStatusOnce,
} from "./test-harness.js";
import type { BlueBubblesAttachment } from "./types.js";

const mockFetch = vi.fn();
const fetchRemoteMediaMock = vi.fn(
  async (params: {
    url: string;
    maxBytes?: number;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(params.url);
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      throw new Error(
        `Failed to fetch media from ${params.url}: HTTP ${res.status}; body: ${text}`,
      );
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
      const error = new Error(`payload exceeds maxBytes ${params.maxBytes}`) as Error & {
        code?: string;
      };
      error.code = "max_bytes";
      throw error;
    }
    return {
      buffer,
      contentType: res.headers.get("content-type") ?? undefined,
      fileName: undefined,
    };
  },
);

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock: vi.mocked(getCachedBlueBubblesPrivateApiStatus),
});

const runtimeStub = {
  channel: {
    media: {
      fetchRemoteMedia:
        fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
    },
  },
} as unknown as PluginRuntime;

describe("downloadBlueBubblesAttachment", () => {
  beforeEach(() => {
    fetchRemoteMediaMock.mockClear();
    mockFetch.mockReset();
    setBlueBubblesRuntime(runtimeStub);
  });

  async function expectAttachmentTooLarge(params: { bufferBytes: number; maxBytes?: number }) {
    const largeBuffer = new Uint8Array(params.bufferBytes);
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
      headers: new Headers(),
      ok: true,
    });

    const attachment: BlueBubblesAttachment = { guid: "att-large" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        password: "test",
        serverUrl: "http://localhost:1234",
        ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
      }),
    ).rejects.toThrow("too large");
  }

  function mockSuccessfulAttachmentDownload(buffer = new Uint8Array([1])) {
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: () => Promise.resolve(buffer.buffer),
      headers: new Headers(),
      ok: true,
    });
    return buffer;
  }

  it("throws when guid is missing", async () => {
    const attachment: BlueBubblesAttachment = {};
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when guid is empty string", async () => {
    const attachment: BlueBubblesAttachment = { guid: "  " };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when serverUrl is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(downloadBlueBubblesAttachment(attachment, {})).rejects.toThrow(
      "serverUrl is required",
    );
  });

  it("throws when password is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
      }),
    ).rejects.toThrow("password is required");
  });

  it("downloads attachment successfully", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      headers: new Headers({ "content-type": "image/png" }),
      ok: true,
    });

    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      password: "test-password",
      serverUrl: "http://localhost:1234",
    });

    expect(result.buffer).toEqual(mockBuffer);
    expect(result.contentType).toBe("image/png");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/attachment/att-123/download"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("includes password in URL query", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      headers: new Headers({ "content-type": "image/jpeg" }),
      ok: true,
    });

    const attachment: BlueBubblesAttachment = { guid: "att-456" };
    await downloadBlueBubblesAttachment(attachment, {
      password: "my-secret-password",
      serverUrl: "http://localhost:1234",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("password=my-secret-password");
  });

  it("encodes guid in URL", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att/with/special chars" };
    await downloadBlueBubblesAttachment(attachment, {
      password: "test",
      serverUrl: "http://localhost:1234",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("att%2Fwith%2Fspecial%20chars");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Attachment not found"),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-missing" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        password: "test",
        serverUrl: "http://localhost:1234",
      }),
    ).rejects.toThrow("Attachment not found");
  });

  it("throws when attachment exceeds max bytes", async () => {
    await expectAttachmentTooLarge({
      bufferBytes: 10 * 1024 * 1024,
      maxBytes: 5 * 1024 * 1024,
    });
  });

  it("uses default max bytes when not specified", async () => {
    await expectAttachmentTooLarge({ bufferBytes: 9 * 1024 * 1024 });
  });

  it("uses attachment mimeType as fallback when response has no content-type", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      headers: new Headers(),
      ok: true,
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-789",
      mimeType: "video/mp4",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      password: "test",
      serverUrl: "http://localhost:1234",
    });

    expect(result.contentType).toBe("video/mp4");
  });

  it("prefers response content-type over attachment mimeType", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      headers: new Headers({ "content-type": "image/webp" }),
      ok: true,
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-xyz",
      mimeType: "image/png",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      password: "test",
      serverUrl: "http://localhost:1234",
    });

    expect(result.contentType).toBe("image/webp");
  });

  it("resolves credentials from config when opts not provided", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-config" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            password: "config-password",
            serverUrl: "http://config-server:5678",
          },
        },
      },
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("config-server:5678");
    expect(calledUrl).toContain("password=config-password");
    expect(result.buffer).toEqual(new Uint8Array([1]));
  });

  it("passes ssrfPolicy with allowPrivateNetwork when config enables it", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-ssrf" };
    await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            password: "test",
            serverUrl: "http://localhost:1234",
          },
        },
      },
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
  });

  it("auto-enables private-network fetches for loopback serverUrl when allowPrivateNetwork is not set", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-no-ssrf" };
    await downloadBlueBubblesAttachment(attachment, {
      cfg: { channels: { bluebubbles: {} } },
      password: "test",
      serverUrl: "http://localhost:1234",
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
  });

  it("auto-enables private-network fetches for private IP serverUrl when allowPrivateNetwork is not set", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-private-ip" };
    await downloadBlueBubblesAttachment(attachment, {
      cfg: { channels: { bluebubbles: {} } },
      password: "test",
      serverUrl: "http://192.168.1.5:1234",
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
  });

  it("respects an explicit private-network opt-out for loopback serverUrl", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-opt-out" };
    await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            network: {
              dangerouslyAllowPrivateNetwork: false,
            },
          },
        },
      },
      password: "test",
      serverUrl: "http://localhost:1234",
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toBeUndefined();
  });

  it("allowlists public serverUrl hostname when allowPrivateNetwork is not set", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-public-host" };
    await downloadBlueBubblesAttachment(attachment, {
      password: "test",
      serverUrl: "https://bluebubbles.example.com:1234",
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowedHostnames: ["bluebubbles.example.com"] });
  });

  it("keeps public serverUrl hostname pinning when private-network access is explicitly disabled", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-public-host-opt-out" };
    await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            network: {
              dangerouslyAllowPrivateNetwork: false,
            },
          },
        },
      },
      password: "test",
      serverUrl: "https://bluebubbles.example.com:1234",
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowedHostnames: ["bluebubbles.example.com"] });
  });
});

describe("sendBlueBubblesAttachment", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    fetchRemoteMediaMock.mockClear();
    setBlueBubblesRuntime(runtimeStub);
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReset();
    mockBlueBubblesPrivateApiStatus(
      vi.mocked(getCachedBlueBubblesPrivateApiStatus),
      BLUE_BUBBLES_PRIVATE_API_STATUS.unknown,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function decodeBody(body: Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }

  function expectVoiceAttachmentBody() {
    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).toContain('name="isAudioMessage"');
    expect(bodyText).toContain("true");
    return bodyText;
  }

  it("marks voice memos when asVoice is true and mp3 is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-1" })),
    });

    await sendBlueBubblesAttachment({
      asVoice: true,
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "audio/mpeg",
      filename: "voice.mp3",
      opts: { password: "test", serverUrl: "http://localhost:1234" },
      to: "chat_guid:iMessage;-;+15551234567",
    });

    const bodyText = expectVoiceAttachmentBody();
    expect(bodyText).toContain('filename="voice.mp3"');
  });

  it("normalizes mp3 filenames for voice memos", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-2" })),
    });

    await sendBlueBubblesAttachment({
      asVoice: true,
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "audio/mpeg",
      filename: "voice",
      opts: { password: "test", serverUrl: "http://localhost:1234" },
      to: "chat_guid:iMessage;-;+15551234567",
    });

    const bodyText = expectVoiceAttachmentBody();
    expect(bodyText).toContain('filename="voice.mp3"');
    expect(bodyText).toContain('name="voice.mp3"');
  });

  it("throws when asVoice is true but media is not audio", async () => {
    await expect(
      sendBlueBubblesAttachment({
        asVoice: true,
        buffer: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        filename: "image.png",
        opts: { password: "test", serverUrl: "http://localhost:1234" },
        to: "chat_guid:iMessage;-;+15551234567",
      }),
    ).rejects.toThrow("voice messages require audio");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when asVoice is true but audio is not mp3 or caf", async () => {
    await expect(
      sendBlueBubblesAttachment({
        asVoice: true,
        buffer: new Uint8Array([1, 2, 3]),
        contentType: "audio/wav",
        filename: "voice.wav",
        opts: { password: "test", serverUrl: "http://localhost:1234" },
        to: "chat_guid:iMessage;-;+15551234567",
      }),
    ).rejects.toThrow("require mp3 or caf");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sanitizes filenames before sending", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-3" })),
    });

    await sendBlueBubblesAttachment({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "audio/mpeg",
      filename: "../evil.mp3",
      opts: { password: "test", serverUrl: "http://localhost:1234" },
      to: "chat_guid:iMessage;-;+15551234567",
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).toContain('filename="evil.mp3"');
    expect(bodyText).toContain('name="evil.mp3"');
  });

  it("downgrades attachment reply threading when private API is disabled", async () => {
    mockBlueBubblesPrivateApiStatusOnce(
      vi.mocked(getCachedBlueBubblesPrivateApiStatus),
      BLUE_BUBBLES_PRIVATE_API_STATUS.disabled,
    );
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-4" })),
    });

    await sendBlueBubblesAttachment({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
      filename: "photo.jpg",
      opts: { password: "test", serverUrl: "http://localhost:1234" },
      replyToMessageGuid: "reply-guid-123",
      to: "chat_guid:iMessage;-;+15551234567",
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).not.toContain('name="method"');
    expect(bodyText).not.toContain('name="selectedMessageGuid"');
    expect(bodyText).not.toContain('name="partIndex"');
  });

  it("warns and downgrades attachment reply threading when private API status is unknown", async () => {
    const runtimeLog = vi.fn();
    setBlueBubblesRuntime({
      ...runtimeStub,
      log: runtimeLog,
    } as unknown as PluginRuntime);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-5" })),
    });

    await sendBlueBubblesAttachment({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
      filename: "photo.jpg",
      opts: { password: "test", serverUrl: "http://localhost:1234" },
      replyToMessageGuid: "reply-guid-unknown",
      to: "chat_guid:iMessage;-;+15551234567",
    });

    expect(runtimeLog).toHaveBeenCalledTimes(1);
    expect(runtimeLog.mock.calls[0]?.[0]).toContain("Private API status unknown");
    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).not.toContain('name="selectedMessageGuid"');
    expect(bodyText).not.toContain('name="partIndex"');
  });

  it("auto-creates a new chat when sending to a phone number with no existing chat", async () => {
    // First call: resolveChatGuidForTarget queries chats, returns empty (no match)
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ data: [] }),
      ok: true,
    });
    // Second call: createChatForHandle creates new chat
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { chatGuid: "iMessage;-;+15559876543", guid: "iMessage;-;+15559876543" },
          }),
        ),
    });
    // Third call: actual attachment send
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ data: { guid: "attach-msg-1" } })),
    });

    const result = await sendBlueBubblesAttachment({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
      filename: "photo.jpg",
      opts: { password: "test", serverUrl: "http://localhost:1234" },
      to: "+15559876543",
    });

    expect(result.messageId).toBe("attach-msg-1");
    // Verify chat creation was called
    const createCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(createCallBody.addresses).toEqual(["+15559876543"]);
    // Verify attachment was sent to the newly created chat
    const attachBody = mockFetch.mock.calls[2][1]?.body as Uint8Array;
    const attachText = decodeBody(attachBody);
    expect(attachText).toContain("iMessage;-;+15559876543");
  });

  it("retries chatGuid resolution after creating a chat with no returned guid", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ data: [] }),
      ok: true,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ data: {} })),
    });
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ data: [{ guid: "iMessage;-;+15557654321" }] }),
      ok: true,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ data: { guid: "attach-msg-2" } })),
    });

    const result = await sendBlueBubblesAttachment({
      buffer: new Uint8Array([4, 5, 6]),
      contentType: "image/jpeg",
      filename: "photo.jpg",
      opts: { password: "test", serverUrl: "http://localhost:1234" },
      to: "+15557654321",
    });

    expect(result.messageId).toBe("attach-msg-2");
    const createCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(createCallBody.addresses).toEqual(["+15557654321"]);
    const attachBody = mockFetch.mock.calls[3][1]?.body as Uint8Array;
    const attachText = decodeBody(attachBody);
    expect(attachText).toContain("iMessage;-;+15557654321");
  });

  it("still throws for non-handle targets when chatGuid is not found", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ data: [] }),
      ok: true,
    });

    await expect(
      sendBlueBubblesAttachment({
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        opts: { password: "test", serverUrl: "http://localhost:1234" },
        to: "chat_id:999",
      }),
    ).rejects.toThrow("chatGuid not found");
  });
});
