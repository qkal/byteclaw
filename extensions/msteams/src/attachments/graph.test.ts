import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock shared.js to avoid transitive runtime-api imports that pull in uninstalled packages.
vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    GRAPH_ROOT: "https://graph.microsoft.com/v1.0",
    applyAuthorizationHeaderForUrl: vi.fn(),
    inferPlaceholder: vi.fn(({ contentType }: { contentType?: string }) =>
      contentType?.startsWith("image/") ? "[image]" : "[file]",
    ),
    isRecord: (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v),
    isUrlAllowed: vi.fn(() => true),
    normalizeContentType: vi.fn((ct: string | null | undefined) => ct ?? undefined),
    resolveAttachmentFetchPolicy: vi.fn(() => ({ allowHosts: ["*"], authAllowHosts: ["*"] })),
    resolveMediaSsrfPolicy: vi.fn(() => undefined),
    resolveRequestUrl: vi.fn((input: string) => input),
    safeFetchWithPolicy: vi.fn(),
  };
});

vi.mock("../../runtime-api.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  getMSTeamsRuntime: vi.fn(() => ({
    channel: {
      media: {
        saveMediaBuffer: vi.fn(async (_buf: Buffer, ct: string) => ({
          contentType: ct ?? "image/png",
          path: "/tmp/saved.png",
        })),
      },
    },
    media: {
      detectMime: vi.fn(async () => "image/png"),
    },
  })),
}));

vi.mock("./download.js", () => ({
  downloadMSTeamsAttachments: vi.fn(async () => []),
}));

vi.mock("./remote-media.js", () => ({
  downloadAndStoreMSTeamsRemoteMedia: vi.fn(),
}));

import { fetchWithSsrFGuard } from "../../runtime-api.js";
import { downloadMSTeamsGraphMedia } from "./graph.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import { safeFetchWithPolicy } from "./shared.js";

function mockFetchResponse(body: unknown, status = 200) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, { headers: { "content-type": "application/json" }, status });
}

function mockBinaryResponse(data: Uint8Array, status = 200) {
  return new Response(Buffer.from(data) as BodyInit, { status });
}

interface GuardedFetchParams { url: string; init?: RequestInit }

function guardedFetchResult(params: GuardedFetchParams, response: Response) {
  return {
    finalUrl: params.url,
    release: async () => {},
    response,
  };
}

function mockGraphMediaFetch(options: {
  messageId: string;
  messageResponse?: unknown;
  hostedContents?: unknown[];
  valueResponses?: Record<string, Response>;
  fetchCalls?: string[];
}) {
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: GuardedFetchParams) => {
    options.fetchCalls?.push(params.url);
    const {url} = params;
    if (url.endsWith(`/messages/${options.messageId}`) && !url.includes("hostedContents")) {
      return guardedFetchResult(
        params,
        mockFetchResponse(options.messageResponse ?? { attachments: [], body: {} }),
      );
    }
    if (url.endsWith("/hostedContents")) {
      return guardedFetchResult(params, mockFetchResponse({ value: options.hostedContents ?? [] }));
    }
    for (const [fragment, response] of Object.entries(options.valueResponses ?? {})) {
      if (url.includes(fragment)) {
        return guardedFetchResult(params, response);
      }
    }
    if (url.endsWith("/attachments")) {
      return guardedFetchResult(params, mockFetchResponse({ value: [] }));
    }
    return guardedFetchResult(params, mockFetchResponse({}, 404));
  });
}

describe("downloadMSTeamsGraphMedia hosted content $value fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches $value endpoint when contentBytes is null but item.id exists", async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG magic bytes

    const fetchCalls: string[] = [];

    mockGraphMediaFetch({
      fetchCalls,
      hostedContents: [{ contentBytes: null, contentType: "image/png", id: "hosted-123" }],
      messageId: "msg-1",
      valueResponses: {
        "/hostedContents/hosted-123/$value": mockBinaryResponse(imageBytes),
      },
    });

    const result = await downloadMSTeamsGraphMedia({
      maxBytes: 10 * 1024 * 1024,
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-1",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    // Verify the $value endpoint was fetched
    const valueCall = fetchCalls.find((u) => u.includes("/hostedContents/hosted-123/$value"));
    expect(valueCall).toBeDefined();
    expect(result.media.length).toBeGreaterThan(0);
    expect(result.hostedCount).toBe(1);
  });

  it("skips hosted content when contentBytes is null and id is missing", async () => {
    mockGraphMediaFetch({
      hostedContents: [{ contentBytes: null, contentType: "image/png" }],
      messageId: "msg-2",
    });

    const result = await downloadMSTeamsGraphMedia({
      maxBytes: 10 * 1024 * 1024,
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-2",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    // No media because there's no id to fetch $value from and no contentBytes
    expect(result.media).toHaveLength(0);
  });

  it("skips $value content when Content-Length exceeds maxBytes", async () => {
    const fetchCalls: string[] = [];

    mockGraphMediaFetch({
      fetchCalls,
      hostedContents: [{ contentBytes: null, contentType: "image/png", id: "hosted-big" }],
      messageId: "msg-cl",
      valueResponses: {
        "/hostedContents/hosted-big/$value": new Response(
          Buffer.from(new Uint8Array([0x89, 0x50, 0x4E, 0x47])) as BodyInit,
          {
            headers: { "content-length": "999999999" },
            status: 200,
          },
        ),
      },
    });

    const result = await downloadMSTeamsGraphMedia({
      maxBytes: 1024,
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-cl",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") }, // 1 KB limit
    });

    // $value was fetched but skipped due to Content-Length exceeding maxBytes
    const valueCall = fetchCalls.find((u) => u.includes("/hostedContents/hosted-big/$value"));
    expect(valueCall).toBeDefined();
    expect(result.media).toHaveLength(0);
  });

  it("uses inline contentBytes when available instead of $value", async () => {
    const fetchCalls: string[] = [];
    const base64Png = Buffer.from([0x89, 0x50, 0x4E, 0x47]).toString("base64");

    mockGraphMediaFetch({
      fetchCalls,
      hostedContents: [{ contentBytes: base64Png, contentType: "image/png", id: "hosted-456" }],
      messageId: "msg-3",
    });

    const result = await downloadMSTeamsGraphMedia({
      maxBytes: 10 * 1024 * 1024,
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-3",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    // Should NOT have fetched $value since contentBytes was available
    const valueCall = fetchCalls.find((u) => u.includes("/$value"));
    expect(valueCall).toBeUndefined();
    expect(result.media.length).toBeGreaterThan(0);
  });

  it("adds the OpenClaw User-Agent to guarded Graph attachment fetches", async () => {
    mockGraphMediaFetch({ messageId: "msg-ua" });

    await downloadMSTeamsGraphMedia({
      maxBytes: 10 * 1024 * 1024,
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-ua",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    const guardCalls = vi.mocked(fetchWithSsrFGuard).mock.calls;
    for (const [call] of guardCalls) {
      const headers = call.init?.headers;
      expect(headers).toBeInstanceOf(Headers);
      expect((headers as Headers).get("Authorization")).toBe("Bearer test-token");
      expect((headers as Headers).get("User-Agent")).toMatch(
        /^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/,
      );
    }
  });

  it("adds the OpenClaw User-Agent to Graph shares downloads for reference attachments", async () => {
    mockGraphMediaFetch({
      messageId: "msg-share",
      messageResponse: {
        attachments: [
          {
            contentType: "reference",
            contentUrl: "https://tenant.sharepoint.com/file.docx",
            name: "file.docx",
          },
        ],
        body: {},
      },
    });
    vi.mocked(safeFetchWithPolicy).mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockImplementation(async (params) => {
      if (params.fetchImpl) {
        await params.fetchImpl(params.url, {});
      }
      return {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        path: "/tmp/file.docx",
        placeholder: "[file]",
      };
    });

    await downloadMSTeamsGraphMedia({
      maxBytes: 10 * 1024 * 1024,
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-share",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    expect(safeFetchWithPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: expect.objectContaining({
          headers: expect.any(Headers),
        }),
      }),
    );
    const requestInit = vi.mocked(safeFetchWithPolicy).mock.calls[0]?.[0]?.requestInit;
    const headers = requestInit?.headers as Headers;
    expect(headers.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
  });
});
