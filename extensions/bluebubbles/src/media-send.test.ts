import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendBlueBubblesMedia } from "./media-send.js";
import type { OpenClawConfig, PluginRuntime } from "./runtime-api.js";
import { setBlueBubblesRuntime } from "./runtime.js";

const sendBlueBubblesAttachmentMock = vi.hoisted(() => vi.fn());
const sendMessageBlueBubblesMock = vi.hoisted(() => vi.fn());
const resolveBlueBubblesMessageIdMock = vi.hoisted(() => vi.fn((id: string) => id));

vi.mock("./attachments.js", () => ({
  sendBlueBubblesAttachment: sendBlueBubblesAttachmentMock,
}));

vi.mock("./send.js", () => ({
  sendMessageBlueBubbles: sendMessageBlueBubblesMock,
}));

vi.mock("./monitor-reply-cache.js", () => ({
  resolveBlueBubblesMessageId: resolveBlueBubblesMessageIdMock,
}));

interface RuntimeMocks {
  detectMime: ReturnType<typeof vi.fn>;
  fetchRemoteMedia: ReturnType<typeof vi.fn>;
}

let runtimeMocks: RuntimeMocks;
const tempDirs: string[] = [];

function createMockRuntime(): { runtime: PluginRuntime; mocks: RuntimeMocks } {
  const detectMime = vi.fn().mockResolvedValue("text/plain");
  const fetchRemoteMedia = vi.fn().mockResolvedValue({
    buffer: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
    fileName: "remote.png",
  });
  return {
    mocks: { detectMime, fetchRemoteMedia },
    runtime: {
      channel: {
        media: {
          fetchRemoteMedia,
        },
      },
      media: {
        detectMime,
      },
      version: "1.0.0",
    } as unknown as PluginRuntime,
  };
}

function createConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      bluebubbles: {
        ...overrides,
      },
    },
  } as unknown as OpenClawConfig;
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bb-media-"));
  tempDirs.push(dir);
  return dir;
}

async function makeTempFile(
  fileName: string,
  contents: string,
  dir?: string,
): Promise<{ dir: string; filePath: string }> {
  const resolvedDir = dir ?? (await makeTempDir());
  const filePath = path.join(resolvedDir, fileName);
  await fs.writeFile(filePath, contents, "utf8");
  return { dir: resolvedDir, filePath };
}

async function sendLocalMedia(params: {
  cfg: OpenClawConfig;
  mediaPath: string;
  accountId?: string;
}) {
  return sendBlueBubblesMedia({
    accountId: params.accountId,
    cfg: params.cfg,
    mediaPath: params.mediaPath,
    to: "chat:123",
  });
}

async function expectRejectedLocalMedia(params: {
  cfg: OpenClawConfig;
  mediaPath: string;
  error: RegExp;
  accountId?: string;
}) {
  await expect(
    sendLocalMedia({
      accountId: params.accountId,
      cfg: params.cfg,
      mediaPath: params.mediaPath,
    }),
  ).rejects.toThrow(params.error);

  expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
}

async function expectAllowedLocalMedia(params: {
  cfg: OpenClawConfig;
  mediaPath: string;
  expectedAttachment: Record<string, unknown>;
  accountId?: string;
  expectMimeDetection?: boolean;
}) {
  const result = await sendLocalMedia({
    accountId: params.accountId,
    cfg: params.cfg,
    mediaPath: params.mediaPath,
  });

  expect(result).toEqual({ messageId: "msg-1" });
  expect(sendBlueBubblesAttachmentMock).toHaveBeenCalledTimes(1);
  expect(sendBlueBubblesAttachmentMock.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining(params.expectedAttachment),
  );
  if (params.expectMimeDetection) {
    expect(runtimeMocks.detectMime).toHaveBeenCalled();
  }
}

beforeEach(() => {
  const runtime = createMockRuntime();
  runtimeMocks = runtime.mocks;
  setBlueBubblesRuntime(runtime.runtime);
  sendBlueBubblesAttachmentMock.mockReset();
  sendBlueBubblesAttachmentMock.mockResolvedValue({ messageId: "msg-1" });
  sendMessageBlueBubblesMock.mockReset();
  sendMessageBlueBubblesMock.mockResolvedValue({ messageId: "msg-caption" });
  resolveBlueBubblesMessageIdMock.mockClear();
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { force: true, recursive: true });
  }
});

describe("sendBlueBubblesMedia local-path hardening", () => {
  it("rejects local paths when mediaLocalRoots is not configured", async () => {
    await expect(
      sendBlueBubblesMedia({
        cfg: createConfig(),
        mediaPath: "/etc/passwd",
        to: "chat:123",
      }),
    ).rejects.toThrow(/mediaLocalRoots/i);

    expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
  });

  it("rejects local paths outside configured mediaLocalRoots", async () => {
    const allowedRoot = await makeTempDir();
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "not allowed", "utf8");

    await expectRejectedLocalMedia({
      cfg: createConfig({ mediaLocalRoots: [allowedRoot] }),
      error: /not under any configured mediaLocalRoots/i,
      mediaPath: outsideFile,
    });
  });

  it("allows local paths that are explicitly configured", async () => {
    const { dir: allowedRoot, filePath: allowedFile } = await makeTempFile(
      "allowed.txt",
      "allowed",
    );

    await expectAllowedLocalMedia({
      cfg: createConfig({ mediaLocalRoots: [allowedRoot] }),
      expectMimeDetection: true,
      expectedAttachment: {
        contentType: "text/plain",
        filename: "allowed.txt",
      },
      mediaPath: allowedFile,
    });
  });

  it("allows file:// media paths and file:// local roots", async () => {
    const { dir: allowedRoot, filePath: allowedFile } = await makeTempFile(
      "allowed.txt",
      "allowed",
    );

    await expectAllowedLocalMedia({
      cfg: createConfig({ mediaLocalRoots: [pathToFileURL(allowedRoot).toString()] }),
      expectedAttachment: {
        filename: "allowed.txt",
      },
      mediaPath: pathToFileURL(allowedFile).toString(),
    });
  });

  it("rejects remote-host file:// media paths", async () => {
    const allowedRoot = await makeTempDir();

    await expectRejectedLocalMedia({
      cfg: createConfig({ mediaLocalRoots: [allowedRoot] }),
      error: /Invalid file:\/\/ URL/i,
      mediaPath: "file://attacker/share/evil.txt",
    });
  });

  it("rejects remote-host file:// mediaLocalRoots entries", async () => {
    const { filePath: allowedFile } = await makeTempFile("allowed.txt", "allowed");

    await expect(
      sendBlueBubblesMedia({
        cfg: createConfig({ mediaLocalRoots: ["file://attacker/share"] }),
        mediaPath: allowedFile,
        to: "chat:123",
      }),
    ).rejects.toThrow(/Invalid file:\/\/ URL in mediaLocalRoots/i);

    expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
  });

  it("uses account-specific mediaLocalRoots over top-level roots", async () => {
    const baseRoot = await makeTempDir();
    const accountRoot = await makeTempDir();
    const baseFile = path.join(baseRoot, "base.txt");
    const accountFile = path.join(accountRoot, "account.txt");
    await fs.writeFile(baseFile, "base", "utf8");
    await fs.writeFile(accountFile, "account", "utf8");

    const cfg = createConfig({
      accounts: {
        work: {
          mediaLocalRoots: [accountRoot],
        },
      },
      mediaLocalRoots: [baseRoot],
    });

    await expect(
      sendBlueBubblesMedia({
        accountId: "work",
        cfg,
        mediaPath: baseFile,
        to: "chat:123",
      }),
    ).rejects.toThrow(/not under any configured mediaLocalRoots/i);

    const result = await sendBlueBubblesMedia({
      accountId: "work",
      cfg,
      mediaPath: accountFile,
      to: "chat:123",
    });

    expect(result).toEqual({ messageId: "msg-1" });
  });

  it("rejects symlink escapes under an allowed root", async () => {
    const allowedRoot = await makeTempDir();
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "secret.txt");
    const linkPath = path.join(allowedRoot, "link.txt");
    await fs.writeFile(outsideFile, "secret", "utf8");

    try {
      await fs.symlink(outsideFile, linkPath);
    } catch {
      // Some environments disallow symlink creation; skip without failing the suite.
      return;
    }

    await expectRejectedLocalMedia({
      cfg: createConfig({ mediaLocalRoots: [allowedRoot] }),
      error: /not under any configured mediaLocalRoots/i,
      mediaPath: linkPath,
    });
  });

  it("rejects relative mediaLocalRoots entries", async () => {
    const allowedRoot = await makeTempDir();
    const allowedFile = path.join(allowedRoot, "allowed.txt");
    const relativeRoot = path.relative(process.cwd(), allowedRoot);
    await fs.writeFile(allowedFile, "allowed", "utf8");

    await expect(
      sendBlueBubblesMedia({
        cfg: createConfig({ mediaLocalRoots: [relativeRoot] }),
        mediaPath: allowedFile,
        to: "chat:123",
      }),
    ).rejects.toThrow(/must be absolute paths/i);

    expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
  });

  it("keeps remote URL flow unchanged", async () => {
    await sendBlueBubblesMedia({
      cfg: createConfig(),
      mediaUrl: "https://example.com/file.png",
      to: "chat:123",
    });

    expect(runtimeMocks.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/file.png" }),
    );
    expect(sendBlueBubblesAttachmentMock).toHaveBeenCalledTimes(1);
  });
});
