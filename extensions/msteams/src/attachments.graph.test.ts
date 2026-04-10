import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { downloadMSTeamsGraphMedia } from "./attachments/graph.js";
import { setMSTeamsRuntime } from "./runtime.js";

const GRAPH_HOST = "graph.microsoft.com";
const SHAREPOINT_HOST = "contoso.sharepoint.com";
const DEFAULT_MESSAGE_URL = `https://${GRAPH_HOST}/v1.0/chats/19%3Achat/messages/123`;
const GRAPH_SHARES_URL_PREFIX = `https://${GRAPH_HOST}/v1.0/shares/`;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_SHAREPOINT_ALLOW_HOSTS = [GRAPH_HOST, SHAREPOINT_HOST];
const DEFAULT_SHARE_REFERENCE_URL = `https://${SHAREPOINT_HOST}/site/file`;
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const PNG_BUFFER = Buffer.from("png");

const detectMimeMock = vi.fn(async () => CONTENT_TYPE_IMAGE_PNG);
const saveMediaBufferMock = vi.fn(async () => ({
  contentType: CONTENT_TYPE_IMAGE_PNG,
  id: "saved.png",
  path: "/tmp/saved.png",
  size: Buffer.byteLength(PNG_BUFFER),
}));
const readRemoteMediaResponse = async (
  res: Response,
  params: { maxBytes?: number; filePathHint?: string },
) => {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
    throw new Error(`payload exceeds maxBytes ${params.maxBytes}`);
  }
  return {
    buffer,
    contentType: res.headers.get("content-type") ?? undefined,
    fileName: params.filePathHint,
  };
};
const fetchRemoteMediaMock = vi.fn(
  async (params: {
    url: string;
    maxBytes?: number;
    filePathHint?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(params.url, { redirect: "manual" });
    return readRemoteMediaResponse(res, params);
  },
);

const runtimeStub = {
  channel: {
    media: {
      fetchRemoteMedia: fetchRemoteMediaMock,
      saveMediaBuffer: saveMediaBufferMock,
    },
  },
  media: {
    detectMime: detectMimeMock,
  },
} as unknown as PluginRuntime;

type DownloadGraphMediaParams = Parameters<typeof downloadMSTeamsGraphMedia>[0];
type DownloadGraphMediaOverrides = Partial<
  Omit<DownloadGraphMediaParams, "messageUrl" | "tokenProvider">
>;
type FetchFn = typeof fetch;
interface LabeledCase { label: string }
interface GraphFetchMockOptions {
  hostedContents?: unknown[];
  attachments?: unknown[];
  messageAttachments?: unknown[];
  onShareRequest?: (url: string) => Response | Promise<Response>;
  onUnhandled?: (url: string) => Response | Promise<Response> | undefined;
}
interface GraphMediaDownloadResult {
  fetchMock: ReturnType<typeof createGraphFetchMock>;
  media: Awaited<ReturnType<typeof downloadMSTeamsGraphMedia>>;
}
type GraphMediaSuccessCase = LabeledCase & {
  buildOptions: () => GraphFetchMockOptions;
  expectedLength: number;
  assert?: (params: GraphMediaDownloadResult) => void;
};

const withLabel = <T extends object>(label: string, fields: T): T & LabeledCase => ({
  label,
  ...fields,
});
const createTokenProvider = (
  tokenOrResolver: string | ((scope: string) => string | Promise<string>) = "token",
) => ({
  getAccessToken: vi.fn(async (scope: string) =>
    typeof tokenOrResolver === "function" ? await tokenOrResolver(scope) : tokenOrResolver,
  ),
});
const createBufferResponse = (payload: Buffer | string, contentType: string, status = 200) => {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return new Response(new Uint8Array(raw), {
    headers: { "content-type": contentType },
    status,
  });
};
const createPdfResponse = (payload: Buffer | string = Buffer.from("pdf")) =>
  createBufferResponse(payload, CONTENT_TYPE_APPLICATION_PDF);
const createJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });
const createGraphCollectionResponse = (value: unknown[]) => createJsonResponse({ value });
const createNotFoundResponse = () => new Response("not found", { status: 404 });
const createRedirectResponse = (location: string, status = 302) =>
  new Response(null, { headers: { location }, status });
const asFetchFn = (fetchFn: unknown): FetchFn => fetchFn as FetchFn;
const expectAttachmentMediaLength = (
  media: Awaited<ReturnType<typeof downloadMSTeamsGraphMedia>>["media"],
  expectedLength: number,
) => {
  expect(media).toHaveLength(expectedLength);
};
const expectMediaBufferSaved = () => {
  expect(saveMediaBufferMock).toHaveBeenCalled();
};

const createHostedContentsWithType = (contentType: string, ...ids: string[]) =>
  ids.map((id) => ({ contentBytes: PNG_BUFFER.toString("base64"), contentType, id }));
const createHostedImageContents = (...ids: string[]) =>
  createHostedContentsWithType(CONTENT_TYPE_IMAGE_PNG, ...ids);
const createReferenceAttachment = (shareUrl = DEFAULT_SHARE_REFERENCE_URL) => ({
  contentType: "reference",
  contentUrl: shareUrl,
  id: "ref-1",
  name: "report.pdf",
});
const buildShareReferenceGraphFetchOptions = (params: {
  referenceAttachment: ReturnType<typeof createReferenceAttachment>;
  onShareRequest?: GraphFetchMockOptions["onShareRequest"];
  onUnhandled?: GraphFetchMockOptions["onUnhandled"];
}) => ({
  attachments: [params.referenceAttachment],
  messageAttachments: [params.referenceAttachment],
  ...(params.onShareRequest ? { onShareRequest: params.onShareRequest } : {}),
  ...(params.onUnhandled ? { onUnhandled: params.onUnhandled } : {}),
});
const buildDefaultShareReferenceGraphFetchOptions = (
  params: Omit<Parameters<typeof buildShareReferenceGraphFetchOptions>[0], "referenceAttachment">,
) =>
  buildShareReferenceGraphFetchOptions({
    referenceAttachment: createReferenceAttachment(),
    ...params,
  });
interface GraphEndpointResponseHandler {
  suffix: string;
  buildResponse: () => Response;
}
const createGraphEndpointResponseHandlers = (params: {
  hostedContents: unknown[];
  attachments: unknown[];
  messageAttachments: unknown[];
}): GraphEndpointResponseHandler[] => [
  {
    buildResponse: () => createGraphCollectionResponse(params.hostedContents),
    suffix: "/hostedContents",
  },
  {
    buildResponse: () => createGraphCollectionResponse(params.attachments),
    suffix: "/attachments",
  },
  {
    buildResponse: () => createJsonResponse({ attachments: params.messageAttachments }),
    suffix: "/messages/123",
  },
];
const resolveGraphEndpointResponse = (
  url: string,
  handlers: GraphEndpointResponseHandler[],
): Response | undefined => {
  const handler = handlers.find((entry) => url.endsWith(entry.suffix));
  return handler ? handler.buildResponse() : undefined;
};

const createGraphFetchMock = (options: GraphFetchMockOptions = {}) => {
  const hostedContents = options.hostedContents ?? [];
  const attachments = options.attachments ?? [];
  const messageAttachments = options.messageAttachments ?? [];
  const endpointHandlers = createGraphEndpointResponseHandlers({
    attachments,
    hostedContents,
    messageAttachments,
  });
  return vi.fn(async (url: string) => {
    const endpointResponse = resolveGraphEndpointResponse(url, endpointHandlers);
    if (endpointResponse) {
      return endpointResponse;
    }
    if (url.startsWith(GRAPH_SHARES_URL_PREFIX) && options.onShareRequest) {
      return options.onShareRequest(url);
    }
    const unhandled = options.onUnhandled ? await options.onUnhandled(url) : undefined;
    return unhandled ?? createNotFoundResponse();
  });
};
const downloadGraphMediaWithMockOptions = async (
  options: GraphFetchMockOptions = {},
  overrides: DownloadGraphMediaOverrides = {},
): Promise<GraphMediaDownloadResult> => {
  const fetchMock = createGraphFetchMock(options);
  const media = await downloadMSTeamsGraphMedia({
    fetchFn: asFetchFn(fetchMock),
    maxBytes: DEFAULT_MAX_BYTES,
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: createTokenProvider(),
    ...overrides,
  });
  return { fetchMock, media };
};
const runGraphMediaSuccessCase = async ({
  buildOptions,
  expectedLength,
  assert,
}: GraphMediaSuccessCase) => {
  const { fetchMock, media } = await downloadGraphMediaWithMockOptions(buildOptions());
  expectAttachmentMediaLength(media.media, expectedLength);
  assert?.({ fetchMock, media });
};

const GRAPH_MEDIA_SUCCESS_CASES: GraphMediaSuccessCase[] = [
  withLabel("downloads hostedContents images", {
    assert: ({ fetchMock }) => {
      expect(fetchMock).toHaveBeenCalled();
      expectMediaBufferSaved();
    },
    buildOptions: () => ({ hostedContents: createHostedImageContents("1") }),
    expectedLength: 1,
  }),
  withLabel("merges SharePoint reference attachments with hosted content", {
    buildOptions: () => ({
        hostedContents: createHostedImageContents("hosted-1"),
        ...buildDefaultShareReferenceGraphFetchOptions({
          onShareRequest: () => createPdfResponse(),
        }),
      }),
    expectedLength: 2,
  }),
];

describe("msteams graph attachments", () => {
  beforeEach(() => {
    detectMimeMock.mockClear();
    fetchRemoteMediaMock.mockClear();
    saveMediaBufferMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  it.each<GraphMediaSuccessCase>(GRAPH_MEDIA_SUCCESS_CASES)("$label", runGraphMediaSuccessCase);

  it("does not forward Authorization for SharePoint redirects outside auth allowlist", async () => {
    const tokenProvider = createTokenProvider("top-secret-token");
    const escapedUrl = "https://example.com/collect";
    const seen: { url: string; auth: string }[] = [];
    const referenceAttachment = createReferenceAttachment();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      seen.push({ auth, url });

      if (url === DEFAULT_MESSAGE_URL) {
        return createJsonResponse({ attachments: [referenceAttachment] });
      }
      if (url === `${DEFAULT_MESSAGE_URL}/hostedContents`) {
        return createGraphCollectionResponse([]);
      }
      if (url === `${DEFAULT_MESSAGE_URL}/attachments`) {
        return createGraphCollectionResponse([referenceAttachment]);
      }
      if (url.startsWith(GRAPH_SHARES_URL_PREFIX)) {
        return createRedirectResponse(escapedUrl);
      }
      if (url === escapedUrl) {
        return createPdfResponse();
      }
      return createNotFoundResponse();
    });

    const media = await downloadMSTeamsGraphMedia({
      allowHosts: [...DEFAULT_SHAREPOINT_ALLOW_HOSTS, "example.com"],
      authAllowHosts: DEFAULT_SHAREPOINT_ALLOW_HOSTS,
      fetchFn: asFetchFn(fetchMock),
      maxBytes: DEFAULT_MAX_BYTES,
      messageUrl: DEFAULT_MESSAGE_URL,
      tokenProvider,
    });

    expectAttachmentMediaLength(media.media, 1);
    const redirected = seen.find((entry) => entry.url === escapedUrl);
    expect(redirected).toBeDefined();
    expect(redirected?.auth).toBe("");
  });

  it("blocks SharePoint redirects to hosts outside allowHosts", async () => {
    const escapedUrl = "https://evil.example/internal.pdf";
    const { fetchMock, media } = await downloadGraphMediaWithMockOptions(
      {
        ...buildDefaultShareReferenceGraphFetchOptions({
          onShareRequest: () => createRedirectResponse(escapedUrl),
          onUnhandled: (url) => {
            if (url === escapedUrl) {
              return createPdfResponse("should-not-be-fetched");
            }
            return undefined;
          },
        }),
      },
      {
        allowHosts: DEFAULT_SHAREPOINT_ALLOW_HOSTS,
      },
    );

    expectAttachmentMediaLength(media.media, 0);
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.some((url) => url.startsWith(GRAPH_SHARES_URL_PREFIX))).toBe(true);
    expect(calledUrls).not.toContain(escapedUrl);
  });

  it("skips inline hosted content when estimated decoded bytes exceed maxBytes", async () => {
    const oversizedBase64 = "A".repeat(16);
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      const { media } = await downloadGraphMediaWithMockOptions(
        {
          hostedContents: [
            {
              contentBytes: oversizedBase64,
              contentType: CONTENT_TYPE_IMAGE_PNG,
              id: "hosted-oversized",
            },
          ],
        },
        { maxBytes: 4 },
      );

      expect(media.media).toEqual([]);
      expect(bufferFromSpy).not.toHaveBeenCalledWith(oversizedBase64, "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  });
});
