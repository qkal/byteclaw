import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSlackMedia = vi.fn();

vi.mock("./monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));

let downloadSlackFile: typeof import("./actions.js").downloadSlackFile;

function createClient() {
  return {
    files: {
      info: vi.fn(async () => ({ file: {} })),
    },
  } as unknown as WebClient & {
    files: {
      info: ReturnType<typeof vi.fn>;
    };
  };
}

function makeSlackFileInfo(overrides?: Record<string, unknown>) {
  return {
    id: "F123",
    mimetype: "image/png",
    name: "image.png",
    url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
    ...overrides,
  };
}

function makeResolvedSlackMedia() {
  return {
    contentType: "image/png",
    path: "/tmp/image.png",
    placeholder: "[Slack file: image.png]",
  };
}

function expectNoMediaDownload(result: Awaited<ReturnType<typeof downloadSlackFile>>) {
  expect(result).toBeNull();
  expect(resolveSlackMedia).not.toHaveBeenCalled();
}

function expectResolveSlackMediaCalledWithDefaults() {
  expect(resolveSlackMedia).toHaveBeenCalledWith({
    files: [
      {
        id: "F123",
        mimetype: "image/png",
        name: "image.png",
        url_private: undefined,
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
      },
    ],
    maxBytes: 1024,
    token: "xoxb-test",
  });
}

function mockSuccessfulMediaDownload(client: ReturnType<typeof createClient>) {
  client.files.info.mockResolvedValueOnce({
    file: makeSlackFileInfo(),
  });
  resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);
}

describe("downloadSlackFile", () => {
  beforeAll(async () => {
    ({ downloadSlackFile } = await import("./actions.js"));
  });

  beforeEach(() => {
    resolveSlackMedia.mockReset();
  });

  it("returns null when files.info has no private download URL", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        name: "image.png",
      },
    });

    const result = await downloadSlackFile("F123", {
      client,
      maxBytes: 1024,
      token: "xoxb-test",
    });

    expect(result).toBeNull();
    expect(resolveSlackMedia).not.toHaveBeenCalled();
  });

  it("downloads via resolveSlackMedia using fresh files.info metadata", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      client,
      maxBytes: 1024,
      token: "xoxb-test",
    });

    expect(client.files.info).toHaveBeenCalledWith({ file: "F123" });
    expectResolveSlackMediaCalledWithDefaults();
    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("returns null when channel scope definitely mismatches file shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({ channels: ["C999"] }),
    });

    const result = await downloadSlackFile("F123", {
      channelId: "C123",
      client,
      maxBytes: 1024,
      token: "xoxb-test",
    });

    expectNoMediaDownload(result);
  });

  it("returns null when thread scope definitely mismatches file share thread", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        shares: {
          private: {
            C123: [{ thread_ts: "111.111", ts: "111.111" }],
          },
        },
      }),
    });

    const result = await downloadSlackFile("F123", {
      channelId: "C123",
      client,
      maxBytes: 1024,
      threadId: "222.222",
      token: "xoxb-test",
    });

    expectNoMediaDownload(result);
  });

  it("keeps legacy behavior when file metadata does not expose channel/thread shares", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      channelId: "C123",
      client,
      maxBytes: 1024,
      threadId: "222.222",
      token: "xoxb-test",
    });

    expect(result).toEqual(makeResolvedSlackMedia());
    expect(resolveSlackMedia).toHaveBeenCalledTimes(1);
    expectResolveSlackMediaCalledWithDefaults();
  });
});
