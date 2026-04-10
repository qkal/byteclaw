import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadWebMedia } from "../../media/web-media.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import { runMessageAction } from "./message-action-runner.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);

const channelResolutionMocks = vi.hoisted(() => ({
  executePollAction: vi.fn(),
  executeSendAction: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  resetOutboundChannelResolutionStateForTest: vi.fn(),
  resolveOutboundChannelPlugin: channelResolutionMocks.resolveOutboundChannelPlugin,
}));

vi.mock("./outbound-send-service.js", () => ({
  executePollAction: channelResolutionMocks.executePollAction,
  executeSendAction: channelResolutionMocks.executeSendAction,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  return createOutboundThreadingMock();
});

vi.mock("../../media/web-media.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
    "../../media/web-media.js",
  );
  return {
    ...actual,
    loadWebMedia: vi.fn(actual.loadWebMedia),
  };
});

const slackConfig = {
  channels: {
    slack: {
      appToken: "xapp-test",
      botToken: "xoxb-test",
    },
  },
} as OpenClawConfig;

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { force: true, recursive: true });
  }
}

const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  sandboxRoot?: string;
}) =>
  runMessageAction({
    action: "send",
    cfg: params.cfg,
    dryRun: true,
    params: params.actionParams as never,
    sandboxRoot: params.sandboxRoot,
  });

async function expectSandboxMediaRewrite(params: {
  sandboxDir: string;
  media?: string;
  mediaField?: "media" | "mediaUrl" | "fileUrl";
  message?: string;
  expectedRelativePath: string;
}) {
  const result = await runDrySend({
    actionParams: {
      channel: "slack",
      target: "#C12345678",
      ...(params.media
        ? {
            [params.mediaField ?? "media"]: params.media,
          }
        : {}),
      ...(params.message ? { message: params.message } : {}),
    },
    cfg: slackConfig,
    sandboxRoot: params.sandboxDir,
  });

  expect(result.kind).toBe("send");
  if (result.kind !== "send") {
    throw new Error("expected send result");
  }
  expect(result.sendResult?.mediaUrl).toBe(
    path.join(params.sandboxDir, params.expectedRelativePath),
  );
}

let actualLoadWebMedia: typeof loadWebMedia;

const slackPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    config: {
      isConfigured: async (account) =>
        typeof (account as { botToken?: unknown }).botToken === "string" &&
        (account as { botToken?: string }).botToken!.trim() !== "" &&
        typeof (account as { appToken?: unknown }).appToken === "string" &&
        (account as { appToken?: string }).appToken!.trim() !== "",
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => cfg.channels?.slack ?? {},
    },
    id: "slack",
    label: "Slack",
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (!trimmed) {
        return {
          error: new Error("missing target for slack"),
          ok: false,
        };
      }
      return { ok: true, to: trimmed };
    },
    sendMedia: async () => ({ channel: "slack", messageId: "msg-test" }),
    sendText: async () => ({ channel: "slack", messageId: "msg-test" }),
  },
};

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    actualLoadWebMedia ??= (
      await vi.importActual<typeof import("../../media/web-media.js")>("../../media/web-media.js")
    ).loadWebMedia;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    channelResolutionMocks.resolveOutboundChannelPlugin.mockReset();
    channelResolutionMocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    channelResolutionMocks.executeSendAction.mockReset();
    channelResolutionMocks.executeSendAction.mockImplementation(
      async ({
        ctx,
        to,
        message,
        mediaUrl,
        mediaUrls,
      }: {
        ctx: { channel: string; dryRun: boolean };
        to: string;
        message: string;
        mediaUrl?: string;
        mediaUrls?: string[];
      }) => ({
        handledBy: "core" as const,
        payload: {
          channel: ctx.channel,
          dryRun: ctx.dryRun,
          mediaUrl,
          mediaUrls,
          message,
          to,
        },
        sendResult: {
          channel: ctx.channel,
          messageId: "msg-test",
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrls ? { mediaUrls } : {}),
        },
      }),
    );
    channelResolutionMocks.executePollAction.mockReset();
    channelResolutionMocks.executePollAction.mockImplementation(async () => {
      throw new Error("executePollAction should not run in media tests");
    });
    vi.mocked(loadWebMedia).mockReset();
    vi.mocked(loadWebMedia).mockImplementation(actualLoadWebMedia);
  });

  describe("sendAttachment hydration", () => {
    const cfg = {
      channels: {
        bluebubbles: {
          enabled: true,
          password: "test-password",
          serverUrl: "http://localhost:1234",
        },
      },
    } as OpenClawConfig;
    const attachmentPlugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({ actions: ["sendAttachment", "upload-file", "setGroupIcon"] }),
        handleAction: async ({ params }) =>
          jsonResult({
            buffer: params.buffer,
            caption: params.caption,
            contentType: params.contentType,
            filename: params.filename,
            ok: true,
          }),
        supportsAction: ({ action }) =>
          action === "sendAttachment" || action === "upload-file" || action === "setGroupIcon",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: {
        isConfigured: () => true,
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
      },
      id: "bluebubbles",
      meta: {
        blurb: "BlueBubbles test plugin.",
        docsPath: "/channels/bluebubbles",
        id: "bluebubbles",
        label: "BlueBubbles",
        selectionLabel: "BlueBubbles",
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: attachmentPlugin,
            pluginId: "bluebubbles",
            source: "test",
          },
        ]),
      );
      vi.mocked(loadWebMedia).mockResolvedValue({
        buffer: Buffer.from("hello"),
        contentType: "image/png",
        fileName: "pic.png",
        kind: "image",
      });
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    async function restoreRealMediaLoader() {
      const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
        "../../media/web-media.js",
      );
      vi.mocked(loadWebMedia).mockImplementation(actual.loadWebMedia);
    }

    async function expectRejectsLocalAbsolutePathWithoutSandbox(params: {
      cfg?: OpenClawConfig;
      action: "sendAttachment" | "setGroupIcon";
      target: string;
      mediaField?: "media" | "mediaUrl" | "fileUrl";
      message?: string;
      tempPrefix: string;
    }) {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        const actionParams: Record<string, unknown> = {
          channel: "bluebubbles",
          target: params.target,
          [params.mediaField ?? "media"]: outsidePath,
        };
        if (params.message) {
          actionParams.message = params.message;
        }

        await expect(
          runMessageAction({
            action: params.action,
            cfg: params.cfg ?? cfg,
            params: actionParams,
          }),
        ).rejects.toThrow(/allowed directory|path-not-allowed/i);
      } finally {
        await fs.rm(tempDir, { force: true, recursive: true });
      }
    }

    it("hydrates buffer and filename from media for sendAttachment", async () => {
      const result = await runMessageAction({
        action: "sendAttachment",
        cfg,
        params: {
          channel: "bluebubbles",
          media: "https://example.com/pic.png",
          message: "caption",
          target: "+15551234567",
        },
      });

      expect(result.kind).toBe("action");
      expect(result.payload).toMatchObject({
        caption: "caption",
        contentType: "image/png",
        filename: "pic.png",
        ok: true,
      });
      expect((result.payload as { buffer?: string }).buffer).toBe(
        Buffer.from("hello").toString("base64"),
      );
      const call = vi.mocked(loadWebMedia).mock.calls[0];
      expect(call?.[1]).toEqual(
        expect.objectContaining({
          hostReadCapability: true,
          localRoots: "any",
          readFile: expect.any(Function),
        }),
      );
      expect((call?.[1] as { sandboxValidated?: boolean } | undefined)?.sandboxValidated).not.toBe(
        true,
      );
    });

    it("allows host-local image attachment paths when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-attachment-image-"));
      try {
        const outsidePath = path.join(tempDir, "photo.png");
        await fs.writeFile(outsidePath, onePixelPng);

        const result = await runMessageAction({
          action: "sendAttachment",
          cfg: {
            ...cfg,
            tools: { fs: { workspaceOnly: false } },
          },
          params: {
            channel: "bluebubbles",
            media: outsidePath,
            message: "caption",
            target: "+15551234567",
          },
        });

        expect(result.kind).toBe("action");
        expect(result.payload).toMatchObject({
          contentType: "image/png",
          filename: "photo.png",
          ok: true,
        });
      } finally {
        await fs.rm(tempDir, { force: true, recursive: true });
      }
    });

    it("rejects host-local text attachments even when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-attachment-text-"));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        await expect(
          runMessageAction({
            action: "sendAttachment",
            cfg: {
              ...cfg,
              tools: { fs: { workspaceOnly: false } },
            },
            params: {
              channel: "bluebubbles",
              media: outsidePath,
              message: "caption",
              target: "+15551234567",
            },
          }),
        ).rejects.toThrow(/Host-local media sends only allow/i);
      } finally {
        await fs.rm(tempDir, { force: true, recursive: true });
      }
    });

    it("hydrates buffer and filename from media for bluebubbles upload-file", async () => {
      const result = await runMessageAction({
        action: "upload-file",
        cfg,
        params: {
          channel: "bluebubbles",
          media: "https://example.com/pic.png",
          message: "caption",
          target: "+15551234567",
        },
      });

      expect(result.kind).toBe("action");
      expect(result.payload).toMatchObject({
        caption: "caption",
        contentType: "image/png",
        filename: "pic.png",
        ok: true,
      });
      expect((result.payload as { buffer?: string }).buffer).toBe(
        Buffer.from("hello").toString("base64"),
      );
    });

    it("enforces sandboxed attachment paths for attachment actions", async () => {
      for (const testCase of [
        {
          action: "sendAttachment" as const,
          expectedPath: path.join("data", "pic.png"),
          media: "./data/pic.png",
          message: "caption",
          name: "sendAttachment rewrite",
          target: "+15551234567",
        },
        {
          action: "sendAttachment" as const,
          expectedPath: path.join("data", "pic.png"),
          media: "./data/pic.png",
          mediaField: "mediaUrl" as const,
          message: "caption",
          name: "sendAttachment mediaUrl rewrite",
          target: "+15551234567",
        },
        {
          action: "sendAttachment" as const,
          expectedPath: path.join("files", "report.pdf"),
          media: "/workspace/files/report.pdf",
          mediaField: "fileUrl" as const,
          message: "caption",
          name: "sendAttachment fileUrl rewrite",
          target: "+15551234567",
        },
        {
          action: "setGroupIcon" as const,
          expectedPath: path.join("icons", "group.png"),
          media: "./icons/group.png",
          name: "setGroupIcon rewrite",
          target: "group:123",
        },
      ]) {
        vi.mocked(loadWebMedia).mockClear();
        await withSandbox(async (sandboxDir) => {
          await runMessageAction({
            action: testCase.action,
            cfg,
            params: {
              channel: "bluebubbles",
              target: testCase.target,
              [testCase.mediaField ?? "media"]: testCase.media,
              ...(testCase.message ? { message: testCase.message } : {}),
            },
            sandboxRoot: sandboxDir,
          });

          const call = vi.mocked(loadWebMedia).mock.calls[0];
          expect(call?.[0], testCase.name).toBe(path.join(sandboxDir, testCase.expectedPath));
          expect(call?.[1], testCase.name).toEqual(
            expect.objectContaining({
              sandboxValidated: true,
            }),
          );
        });
      }

      for (const testCase of [
        {
          action: "sendAttachment" as const,
          message: "caption",
          target: "+15551234567",
          tempPrefix: "msg-attachment-",
        },
        {
          action: "sendAttachment" as const,
          mediaField: "mediaUrl" as const,
          message: "caption",
          target: "+15551234567",
          tempPrefix: "msg-attachment-media-url-",
        },
        {
          action: "sendAttachment" as const,
          mediaField: "fileUrl" as const,
          message: "caption",
          target: "+15551234567",
          tempPrefix: "msg-attachment-file-url-",
        },
        {
          action: "setGroupIcon" as const,
          target: "group:123",
          tempPrefix: "msg-group-icon-",
        },
      ]) {
        await expectRejectsLocalAbsolutePathWithoutSandbox({
          ...testCase,
          cfg: { tools: { fs: { workspaceOnly: true } } },
        });
      }
    });
  });

  describe("sandboxed media validation", () => {
    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: slackPlugin,
            pluginId: "slack",
            source: "test",
          },
        ]),
      );
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
    });

    it.each([
      {
        media: "/etc/passwd",
        mediaField: "media" as const,
        name: "media absolute path",
      },
      {
        media: "/etc/passwd",
        mediaField: "mediaUrl" as const,
        name: "mediaUrl absolute path",
      },
      {
        media: "file:///etc/passwd",
        mediaField: "mediaUrl" as const,
        name: "mediaUrl file URL",
      },
      {
        media: "file:///etc/passwd",
        mediaField: "fileUrl" as const,
        name: "fileUrl file URL",
      },
    ])("rejects out-of-sandbox media reference: $name", async ({ mediaField, media }) => {
      await withSandbox(async (sandboxDir) => {
        await expect(
          runDrySend({
            actionParams: {
              channel: "slack",
              target: "#C12345678",
              [mediaField]: media,
              message: "",
            },
            cfg: slackConfig,
            sandboxRoot: sandboxDir,
          }),
        ).rejects.toThrow(/sandbox/i);
      });
    });

    it("rejects data URLs in media params", async () => {
      await expect(
        runDrySend({
          actionParams: {
            channel: "slack",
            media: "data:image/png;base64,abcd",
            message: "",
            target: "#C12345678",
          },
          cfg: slackConfig,
        }),
      ).rejects.toThrow(/data:/i);
    });

    it("rewrites in-sandbox media references before dry send", async () => {
      for (const testCase of [
        {
          expectedRelativePath: path.join("data", "file.txt"),
          media: "./data/file.txt",
          message: "",
          name: "relative media path",
        },
        {
          expectedRelativePath: path.join("data", "file.txt"),
          media: "./data/file.txt",
          mediaField: "mediaUrl" as const,
          message: "",
          name: "relative mediaUrl path",
        },
        {
          expectedRelativePath: path.join("data", "file.txt"),
          media: "/workspace/data/file.txt",
          mediaField: "fileUrl" as const,
          message: "",
          name: "/workspace fileUrl path",
        },
        {
          expectedRelativePath: path.join("data", "file.txt"),
          media: "/workspace/data/file.txt",
          message: "",
          name: "/workspace media path",
        },
        {
          expectedRelativePath: path.join("data", "note.ogg"),
          message: "Hello\nMEDIA: ./data/note.ogg",
          name: "MEDIA directive",
        },
      ] as const) {
        await withSandbox(async (sandboxDir) => {
          await expectSandboxMediaRewrite({
            expectedRelativePath: testCase.expectedRelativePath,
            media: testCase.media,
            mediaField: testCase.mediaField,
            message: testCase.message,
            sandboxDir,
          });
        });
      }
    });

    it("prefers media over mediaUrl when both aliases are present", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runDrySend({
          actionParams: {
            channel: "slack",
            media: "./data/primary.txt",
            mediaUrl: "./data/secondary.txt",
            message: "",
            target: "#C12345678",
          },
          cfg: slackConfig,
          sandboxRoot: sandboxDir,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "data", "primary.txt"));
      });
    });

    it.each([
      {
        mediaField: "mediaUrl" as const,
        name: "mediaUrl",
      },
      {
        mediaField: "fileUrl" as const,
        name: "fileUrl",
      },
    ])(
      "keeps remote HTTP $name aliases unchanged under sandbox validation",
      async ({ mediaField }) => {
        await withSandbox(async (sandboxDir) => {
          const remoteUrl = "https://example.com/files/report.pdf?sig=1";
          const result = await runDrySend({
            actionParams: {
              channel: "slack",
              target: "#C12345678",
              [mediaField]: remoteUrl,
              message: "",
            },
            cfg: slackConfig,
            sandboxRoot: sandboxDir,
          });

          expect(result.kind).toBe("send");
          if (result.kind !== "send") {
            throw new Error("expected send result");
          }
          expect(result.sendResult?.mediaUrl).toBe(remoteUrl);
        });
      },
    );

    it("allows media paths under preferred OpenClaw tmp root", async () => {
      const tmpRoot = resolvePreferredOpenClawTmpDir();
      await fs.mkdir(tmpRoot, { recursive: true });
      const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
      try {
        const tmpFile = path.join(tmpRoot, "test-media-image.png");
        const result = await runMessageAction({
          action: "send",
          cfg: slackConfig,
          dryRun: true,
          params: {
            channel: "slack",
            media: tmpFile,
            message: "",
            target: "#C12345678",
          },
          sandboxRoot: sandboxDir,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        expect(result.sendResult?.mediaUrl).toBe(path.resolve(tmpFile));
        const hostTmpOutsideOpenClaw = path.join(os.tmpdir(), "outside-openclaw", "test-media.png");
        await expect(
          runMessageAction({
            action: "send",
            cfg: slackConfig,
            dryRun: true,
            params: {
              channel: "slack",
              media: hostTmpOutsideOpenClaw,
              message: "",
              target: "#C12345678",
            },
            sandboxRoot: sandboxDir,
          }),
        ).rejects.toThrow(/sandbox/i);
      } finally {
        await fs.rm(sandboxDir, { force: true, recursive: true });
      }
    });
  });
});
