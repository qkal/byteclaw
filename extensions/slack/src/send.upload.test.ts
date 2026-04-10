import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSlackBlockTestMocks } from "./blocks.test-helpers.js";

// --- Module mocks (must precede dynamic import) ---
installSlackBlockTestMocks();
const loadOutboundMediaFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_mediaUrl: string, _options?: unknown) => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    fileName: "screenshot.png",
    kind: "image",
  })),
);
const fetchWithSsrFGuard = vi.fn(
  async (params: { url: string; init?: RequestInit }) =>
    ({
      finalUrl: params.url,
      release: async () => {},
      response: await fetch(params.url, params.init),
    }) as const,
);

vi.mock("../../../src/infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    fetchWithSsrFGuard(...(args as [params: { url: string; init?: RequestInit }])),
  withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  }),
}));

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  const mockedLoadOutboundMediaFromUrl =
    loadOutboundMediaFromUrlMock as unknown as typeof actual.loadOutboundMediaFromUrl;
  return {
    ...actual,
    loadOutboundMediaFromUrl: (...args: Parameters<typeof actual.loadOutboundMediaFromUrl>) =>
      mockedLoadOutboundMediaFromUrl(...args),
  };
});

let sendMessageSlack: typeof import("./send.js").sendMessageSlack;
let clearSlackDmChannelCache: typeof import("./send.js").clearSlackDmChannelCache;
({ sendMessageSlack, clearSlackDmChannelCache } = await import("./send.js"));

type UploadTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn>;
    completeUploadExternal: ReturnType<typeof vi.fn>;
  };
};

function createUploadTestClient(): UploadTestClient {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D99RESOLVED" } })),
    },
    files: {
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
      getUploadURLExternal: vi.fn(async () => ({
        file_id: "F001",
        ok: true,
        upload_url: "https://uploads.slack.test/upload",
      })),
    },
  } as unknown as UploadTestClient;
}

describe("sendMessageSlack file upload with user IDs", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    fetchWithSsrFGuard.mockClear();
    loadOutboundMediaFromUrlMock.mockClear();
    clearSlackDmChannelCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves bare user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    // Bare user ID — parseSlackTarget classifies this as kind="channel"
    await sendMessageSlack("U2ZH3MFSR", "screenshot", {
      client,
      mediaUrl: "/tmp/screenshot.png",
      token: "xoxb-test",
    });

    // Should call conversations.open to resolve user ID → DM channel
    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U2ZH3MFSR",
    });

    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D99RESOLVED",
        files: [expect.objectContaining({ id: "F001", title: "screenshot.png" })],
      }),
    );
  });

  it("resolves prefixed user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "image", {
      client,
      mediaUrl: "/tmp/photo.png",
      token: "xoxb-test",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "UABC123",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("caches DM channel resolution per account", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "first", {
      client,
      token: "xoxb-test",
    });
    await sendMessageSlack("user:UABC123", "second", {
      client,
      token: "xoxb-test",
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "D99RESOLVED",
        text: "second",
      }),
    );
  });

  it("scopes DM channel resolution cache by token identity", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "first", {
      client,
      token: "xoxb-test-a",
    });
    await sendMessageSlack("user:UABC123", "second", {
      client,
      token: "xoxb-test-b",
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(2);
  });

  it("sends file directly to channel without conversations.open", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "chart", {
      client,
      mediaUrl: "/tmp/chart.png",
      token: "xoxb-test",
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "C123CHAN" }),
    );
  });

  it("resolves mention-style user ID before file upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("<@U777TEST>", "report", {
      client,
      mediaUrl: "/tmp/report.png",
      token: "xoxb-test",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U777TEST",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("uploads bytes to the presigned URL and completes with thread+caption", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      client,
      mediaUrl: "/tmp/threaded.png",
      threadTs: "171.222",
      token: "xoxb-test",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "screenshot.png",
      length: Buffer.from("fake-image").length,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://uploads.slack.test/upload",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "slack-upload-file",
        mode: "trusted_env_proxy",
        url: "https://uploads.slack.test/upload",
      }),
    );
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123CHAN",
        initial_comment: "caption",
        thread_ts: "171.222",
      }),
    );
  });

  it("uses explicit upload filename and title overrides when provided", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      client,
      mediaUrl: "/tmp/threaded.png",
      token: "xoxb-test",
      uploadFileName: "custom-name.bin",
      uploadTitle: "Custom Title",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ id: "F001", title: "Custom Title" })],
      }),
    );
  });

  it("uses uploadFileName as the title fallback when uploadTitle is omitted", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      client,
      mediaUrl: "/tmp/threaded.png",
      token: "xoxb-test",
      uploadFileName: "custom-name.bin",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ id: "F001", title: "custom-name.bin" })],
      }),
    );
  });
});
