import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.fn();
const convertHeicToJpegMock = vi.fn();
const detectMimeMock = vi.fn();

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("./image-ops.js", () => ({
  convertHeicToJpeg: (...args: unknown[]) => convertHeicToJpegMock(...args),
}));

vi.mock("./mime.js", () => ({
  detectMime: (...args: unknown[]) => detectMimeMock(...args),
}));

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

let fetchWithGuard: typeof import("./input-files.js").fetchWithGuard;
let extractImageContentFromSource: typeof import("./input-files.js").extractImageContentFromSource;
let extractFileContentFromSource: typeof import("./input-files.js").extractFileContentFromSource;

beforeAll(async () => {
  ({ fetchWithGuard, extractImageContentFromSource, extractFileContentFromSource } =
    await import("./input-files.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

function createImageSourceLimits(allowedMimes: string[], allowUrl = false) {
  return {
    allowUrl,
    allowedMimes: new Set(allowedMimes),
    maxBytes: 1024 * 1024,
    maxRedirects: 0,
    timeoutMs: allowUrl ? 1000 : 1,
  };
}

async function expectRejectedImageMimeCase(params: {
  source: Parameters<typeof extractImageContentFromSource>[0];
  limits: Parameters<typeof extractImageContentFromSource>[1];
  expectedError: string;
  fetchedUrl?: string;
  fetchedContentType?: string;
  fetchedBody?: Uint8Array;
}) {
  const release = vi.fn(async () => {});
  if (params.source.type === "url") {
    const responseBody = Uint8Array.from(params.fetchedBody ?? Buffer.from("url-source"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      finalUrl: params.fetchedUrl ?? params.source.url,
      release,
      response: new Response(
        responseBody.buffer.slice(
          responseBody.byteOffset,
          responseBody.byteOffset + responseBody.byteLength,
        ),
        {
          headers: { "content-type": params.fetchedContentType ?? "application/octet-stream" },
          status: 200,
        },
      ),
    });
  }
  await expect(extractImageContentFromSource(params.source, params.limits)).rejects.toThrow(
    params.expectedError,
  );
  if (params.source.type === "url") {
    expect(release).toHaveBeenCalledTimes(1);
  }
}

type ImageSourceLimits = Parameters<typeof extractImageContentFromSource>[1];

async function expectResolvedImageContentCase(params: {
  source: Parameters<typeof extractImageContentFromSource>[0];
  limits: ImageSourceLimits;
  detectedMime: string;
  convertedBytes?: Buffer;
  fetchedUrl?: string;
  fetchedContentType?: string;
  fetchedBody?: Uint8Array;
  expectedImage: Awaited<ReturnType<typeof extractImageContentFromSource>>;
}) {
  const release = vi.fn(async () => {});
  if (params.source.type === "url") {
    const responseBody = Uint8Array.from(params.fetchedBody ?? Buffer.from("url-source"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      finalUrl: params.fetchedUrl ?? params.source.url,
      release,
      response: new Response(
        responseBody.buffer.slice(
          responseBody.byteOffset,
          responseBody.byteOffset + responseBody.byteLength,
        ),
        {
          headers: { "content-type": params.fetchedContentType ?? "application/octet-stream" },
          status: 200,
        },
      ),
    });
  }
  detectMimeMock.mockResolvedValueOnce(params.detectedMime);
  if (params.convertedBytes) {
    convertHeicToJpegMock.mockResolvedValueOnce(params.convertedBytes);
  }

  const image = await extractImageContentFromSource(params.source, params.limits);

  expect(image).toEqual(params.expectedImage);
  expect(detectMimeMock).toHaveBeenCalledTimes(1);
  expect(convertHeicToJpegMock).toHaveBeenCalledTimes(params.convertedBytes ? 1 : 0);
  if (params.source.type === "url") {
    expect(release).toHaveBeenCalledTimes(1);
  }
}

async function expectBase64ImageValidationCase(params: {
  source: Parameters<typeof extractImageContentFromSource>[0];
  limits: Parameters<typeof extractImageContentFromSource>[1];
  expectedData?: string;
  expectedError?: string;
}) {
  if (params.expectedError) {
    await expect(extractImageContentFromSource(params.source, params.limits)).rejects.toThrow(
      params.expectedError,
    );
    return;
  }

  const image = await extractImageContentFromSource(params.source, params.limits);
  expect(image.data).toBe(params.expectedData);
}

describe("HEIC input image normalization", () => {
  it.each([
    {
      convertedBytes: Buffer.from("jpeg-normalized"),
      detectedMime: "image/heic",
      expectedImage: {
        data: Buffer.from("jpeg-normalized").toString("base64"),
        mimeType: "image/jpeg",
        type: "image",
      },
      limits: createImageSourceLimits(["image/heic", "image/jpeg"]),
      name: "converts base64 HEIC images to JPEG before returning them",
      source: {
        data: Buffer.from("heic-source").toString("base64"),
        mediaType: "image/heic",
        type: "base64",
      } as const,
    },
    {
      convertedBytes: Buffer.from("jpeg-url-normalized"),
      detectedMime: "image/heic",
      expectedImage: {
        data: Buffer.from("jpeg-url-normalized").toString("base64"),
        mimeType: "image/jpeg",
        type: "image",
      },
      fetchedBody: Buffer.from("heic-url-source"),
      fetchedContentType: "image/heic",
      fetchedUrl: "https://example.com/photo.heic",
      limits: createImageSourceLimits(["image/heic", "image/jpeg"], true),
      name: "converts URL HEIC images to JPEG before returning them",
      source: {
        type: "url",
        url: "https://example.com/photo.heic",
      } as const,
    },
    {
      detectedMime: "image/png",
      expectedImage: {
        data: Buffer.from("png-like").toString("base64"),
        mimeType: "image/png",
        type: "image",
      },
      limits: createImageSourceLimits(["image/png"]),
      name: "keeps declared MIME for non-HEIC images after validation",
      source: {
        data: Buffer.from("png-like").toString("base64"),
        mediaType: "image/png",
        type: "base64",
      } as const,
    },
  ] as const)("$name", async (testCase) => {
    await expectResolvedImageContentCase(testCase);
  });

  it.each([
    {
      expectedError: "Unsupported image MIME type: application/pdf",
      limits: createImageSourceLimits(["image/png", "image/jpeg"]),
      name: "rejects spoofed base64 images when detected bytes are not an image",
      source: {
        data: Buffer.from("%PDF-1.4\n").toString("base64"),
        mediaType: "image/png",
        type: "base64" as const,
      },
    },
    {
      expectedError: "Unsupported image MIME type: application/pdf",
      fetchedBody: Buffer.from("%PDF-1.4\n"),
      fetchedContentType: "image/png",
      fetchedUrl: "https://example.com/photo.png",
      limits: createImageSourceLimits(["image/png", "image/jpeg"], true),
      name: "rejects spoofed URL images when detected bytes are not an image",
      source: {
        type: "url" as const,
        url: "https://example.com/photo.png",
      },
    },
  ] as const)("$name", async (testCase) => {
    detectMimeMock.mockResolvedValueOnce("application/pdf");
    await expectRejectedImageMimeCase(testCase);
    expect(convertHeicToJpegMock).not.toHaveBeenCalled();
  });
});

describe("fetchWithGuard", () => {
  it("rejects oversized streamed payloads and cancels the stream", async () => {
    let canceled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        }
        // Keep stream open; cancel() should stop it once maxBytes exceeded
      },
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
    });

    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      finalUrl: "https://example.com/file.bin",
      release,
      response: new Response(stream, {
        headers: { "content-type": "application/octet-stream" },
        status: 200,
      }),
    });

    await expect(
      fetchWithGuard({
        maxBytes: 6,
        maxRedirects: 0,
        timeoutMs: 1000,
        url: "https://example.com/file.bin",
      }),
    ).rejects.toThrow("Content too large");

    // Allow cancel() microtask to run.
    await waitForMicrotaskTurn();

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("base64 size guards", () => {
  it.each([
    {
      expectedError: "Image too large",
      kind: "images",
      run: async (data: string) => await extractImageContentFromSource(
          { type: "base64", data, mediaType: "image/png" },
          {
            allowUrl: false,
            allowedMimes: new Set(["image/png"]),
            maxBytes: 6,
            maxRedirects: 0,
            timeoutMs: 1,
          },
        ),
    },
    {
      expectedError: "File too large",
      kind: "files",
      run: async (data: string) => await extractFileContentFromSource({
          source: { type: "base64", data, mediaType: "text/plain", filename: "x.txt" },
          limits: {
            allowUrl: false,
            allowedMimes: new Set(["text/plain"]),
            maxBytes: 6,
            maxChars: 100,
            maxRedirects: 0,
            timeoutMs: 1,
            pdf: { maxPages: 1, maxPixels: 1, minTextChars: 1 },
          },
        }),
    },
  ] as const)("rejects oversized base64 $kind before decoding", async (testCase) => {
    const data = Buffer.alloc(7).toString("base64");
    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(testCase.run(data)).rejects.toThrow(testCase.expectedError);

    // Regression check: oversize reject happens before Buffer.from(..., "base64") allocates.
    const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
  });
});

describe("input image base64 validation", () => {
  it.each([
    {
      expectedError: "invalid 'data' field",
      limits: {
        allowUrl: false,
        allowedMimes: new Set(["image/png"]),
        maxBytes: 1024 * 1024,
        maxRedirects: 0,
        timeoutMs: 1,
      },
      name: "rejects malformed base64 payloads",
      source: {
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
        mediaType: "image/png",
        type: "base64",
      } as const,
    },
    {
      expectedData: "aGVsbG8=",
      limits: createImageSourceLimits(["image/png"]),
      name: "normalizes whitespace in valid base64 payloads",
      source: {
        data: " aGVs bG8= \n",
        mediaType: "image/png",
        type: "base64",
      } as const,
    },
  ] as const)("$name", async ({ source, limits, expectedData, expectedError }) => {
    await expectBase64ImageValidationCase({
      limits,
      source,
      ...(expectedData ? { expectedData } : {}),
      ...(expectedError ? { expectedError } : {}),
    });
  });
});
