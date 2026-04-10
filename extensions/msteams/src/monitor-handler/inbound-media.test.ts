import { describe, expect, it, vi } from "vitest";

vi.mock("../attachments.js", () => ({
  buildMSTeamsGraphMessageUrls: vi.fn(() => [
    "https://graph.microsoft.com/v1.0/chats/c/messages/m",
  ]),
  downloadMSTeamsAttachments: vi.fn(async () => []),
  downloadMSTeamsBotFrameworkAttachments: vi.fn(async () => ({ attachmentCount: 0, media: [] })),
  downloadMSTeamsGraphMedia: vi.fn(async () => ({ media: [] })),
  extractMSTeamsHtmlAttachmentIds: vi.fn(() => ["att-0", "att-1"]),
  isBotFrameworkPersonalChatId: vi.fn((id: string | null | undefined) => {
    if (typeof id !== "string") {
      return false;
    }
    return id.startsWith("a:") || id.startsWith("8:orgid:");
  }),
}));

import {
  buildMSTeamsGraphMessageUrls,
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  extractMSTeamsHtmlAttachmentIds,
} from "../attachments.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

const baseParams = {
  activity: { channelData: {}, id: "msg-1", replyToId: undefined },
  conversationId: "19:user_bot@unq.gbl.spaces",
  conversationType: "personal",
  log: { debug: vi.fn() },
  maxBytes: 1024 * 1024,
  tokenProvider: { getAccessToken: vi.fn(async () => "token") },
};

describe("resolveMSTeamsInboundMedia graph fallback trigger", () => {
  it("triggers Graph fallback when some attachments are text/html (some() behavior)", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({
      media: [{ contentType: "image/png", path: "/tmp/img.png", placeholder: "[image]" }],
    });

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        { content: "<div><img src='x'/></div>", contentType: "text/html" },
        { contentType: "image/png", contentUrl: "https://example.com/img.png" },
      ],
    });

    expect(buildMSTeamsGraphMessageUrls).toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when no attachments are text/html", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        { contentType: "image/png", contentUrl: "https://example.com/img.png" },
        { contentType: "application/pdf", contentUrl: "https://example.com/doc.pdf" },
      ],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when direct download succeeds", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([
      { contentType: "image/png", path: "/tmp/img.png", placeholder: "[image]" },
    ]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [{ content: "<div><img src='x'/></div>", contentType: "text/html" }],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });
});

describe("resolveMSTeamsInboundMedia bot framework DM routing", () => {
  const dmParams = {
    ...baseParams,
    conversationId: "a:1dRsHCobZ1AxURzY05Dc",
    conversationType: "personal",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
  };

  it("routes 'a:' conversation IDs through the Bot Framework attachment endpoint", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
      attachmentCount: 1,
      media: [
        {
          contentType: "application/pdf",
          path: "/tmp/report.pdf",
          placeholder: "<media:document>",
        },
      ],
    });
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    const mediaList = await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          content: '<div>A file <attachment id="att-0"></attachment></div>',
          contentType: "text/html",
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalledTimes(1);
    const call = vi.mocked(downloadMSTeamsBotFrameworkAttachments).mock.calls[0]?.[0];
    expect(call?.serviceUrl).toBe(dmParams.serviceUrl);
    expect(call?.attachmentIds).toEqual(["att-0", "att-1"]);
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(mediaList).toHaveLength(1);
    expect(mediaList[0].path).toBe("/tmp/report.pdf");
  });

  it("skips the Graph fallback entirely for 'a:' conversation IDs", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
      attachmentCount: 1,
      media: [],
    });
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();

    await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          content: '<div><attachment id="att-0"></attachment></div>',
          contentType: "text/html",
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalled();
    expect(buildMSTeamsGraphMessageUrls).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT call the Bot Framework endpoint for Graph-compatible '19:' IDs", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({ media: [] });

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        {
          content: '<div><attachment id="att-0"></attachment></div>',
          contentType: "text/html",
        },
      ],
      conversationId: "19:abc@thread.tacv2",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("logs when no attachment IDs are present on a BF DM with HTML content", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    const log = { debug: vi.fn() };

    await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [{ content: "<div>no attachments here</div>", contentType: "text/html" }],
      log,
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "bot framework attachment ids unavailable",
      expect.objectContaining({ conversationType: "personal" }),
    );
  });

  it("logs when serviceUrl is missing for a BF DM with HTML content", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();
    const log = { debug: vi.fn() };

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        {
          content: '<div><attachment id="att-0"></attachment></div>',
          contentType: "text/html",
        },
      ],
      conversationId: "a:bf-dm-id",
      conversationType: "personal",
      log,
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    // Graph fallback is also skipped because the ID is 'a:'
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "bot framework attachment skipped (missing serviceUrl)",
      expect.objectContaining({
        conversationId: "a:bf-dm-id",
        conversationType: "personal",
      }),
    );
  });
});
