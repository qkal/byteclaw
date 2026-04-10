import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

type OutboundMediaModule = typeof import("./outbound-media.js");

let loadOutboundMediaFromUrl: OutboundMediaModule["loadOutboundMediaFromUrl"];

describe("loadOutboundMediaFromUrl", () => {
  beforeAll(async () => {
    const webMedia = await import("./web-media.js");
    vi.spyOn(webMedia, "loadWebMedia").mockImplementation(loadWebMediaMock);
    ({ loadOutboundMediaFromUrl } = await import("./outbound-media.js"));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    loadWebMediaMock.mockReset();
  });

  it("forwards maxBytes and mediaLocalRoots to loadWebMedia", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      contentType: "image/png",
      kind: "image",
    });

    await loadOutboundMediaFromUrl("file:///tmp/image.png", {
      maxBytes: 1024,
      mediaLocalRoots: ["/tmp/workspace-agent"],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("file:///tmp/image.png", {
      localRoots: ["/tmp/workspace-agent"],
      maxBytes: 1024,
    });
  });

  it("keeps options optional", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      contentType: "image/png",
      kind: "image",
    });

    await loadOutboundMediaFromUrl("https://example.com/image.png");

    expect(loadWebMediaMock).toHaveBeenCalledWith("https://example.com/image.png", {});
  });

  it("prefers host read capability over local roots when provided", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("x"));
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      contentType: "image/png",
      kind: "image",
    });

    await loadOutboundMediaFromUrl("/Users/peter/Pictures/image.png", {
      maxBytes: 2048,
      mediaLocalRoots: ["/tmp/workspace-agent"],
      mediaReadFile,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("/Users/peter/Pictures/image.png", {
      hostReadCapability: true,
      localRoots: "any",
      maxBytes: 2048,
      readFile: mediaReadFile,
    });
  });
});
