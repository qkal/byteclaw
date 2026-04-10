import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { createChannelReplyPipeline } from "../runtime-api.js";

vi.mock("../../../test/helpers/config/bundled-channel-config-runtime.js", () => ({
  getBundledChannelConfigSchemaMap: () => new Map(),
  getBundledChannelRuntimeMap: () => new Map(),
}));

const { sendMessageMattermostMock, mockFetchGuard } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(async (p: { url: string; init?: RequestInit }) => {
    const response = await globalThis.fetch(p.url, p.init);
    return { finalUrl: p.url, release: async () => {}, response };
  }),
  sendMessageMattermostMock: vi.fn(),
}));

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: sendMessageMattermostMock,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/ssrf-runtime")) as Record<
    string,
    unknown
  >;
  return { ...original, fetchWithSsrFGuard: mockFetchGuard };
});

import { mattermostPlugin } from "./channel.js";
import { resetMattermostReactionBotUserCacheForTests } from "./mattermost/reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";

type MattermostHandleAction = NonNullable<
  NonNullable<typeof mattermostPlugin.actions>["handleAction"]
>;
type MattermostActionContext = Parameters<MattermostHandleAction>[0];
type MattermostSendText = NonNullable<NonNullable<typeof mattermostPlugin.outbound>["sendText"]>;
type MattermostSendTextParams = Parameters<MattermostSendText>[0];
type MattermostSendMedia = NonNullable<NonNullable<typeof mattermostPlugin.outbound>["sendMedia"]>;
type MattermostSendMediaParams = Parameters<MattermostSendMedia>[0];

function getDescribedActions(cfg: OpenClawConfig, accountId?: string): string[] {
  return [...(mattermostPlugin.actions?.describeMessageTool?.({ accountId, cfg })?.actions ?? [])];
}

function requireMattermostNormalizeTarget() {
  const normalize = mattermostPlugin.messaging?.normalizeTarget;
  if (!normalize) {
    throw new Error("mattermost messaging.normalizeTarget missing");
  }
  return normalize;
}

function requireMattermostPairingNormalizer() {
  const normalize = mattermostPlugin.pairing?.normalizeAllowEntry;
  if (!normalize) {
    throw new Error("mattermost pairing.normalizeAllowEntry missing");
  }
  return normalize;
}

function requireMattermostReplyToModeResolver() {
  const resolveReplyToMode = mattermostPlugin.threading?.resolveReplyToMode;
  if (!resolveReplyToMode) {
    throw new Error("mattermost threading.resolveReplyToMode missing");
  }
  return resolveReplyToMode;
}

function requireMattermostSendText() {
  const sendText = mattermostPlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("mattermost outbound.sendText missing");
  }
  return sendText;
}

function requireMattermostSendMedia() {
  const sendMedia = mattermostPlugin.outbound?.sendMedia;
  if (!sendMedia) {
    throw new Error("mattermost outbound.sendMedia missing");
  }
  return sendMedia;
}

function requireMattermostChunker() {
  const chunker = mattermostPlugin.outbound?.chunker;
  if (!chunker) {
    throw new Error("mattermost outbound.chunker missing");
  }
  return chunker;
}

function createMattermostActionContext(
  overrides: Partial<MattermostActionContext>,
): MattermostActionContext {
  return {
    action: "send",
    cfg: createMattermostTestConfig(),
    channel: "mattermost",
    params: {},
    ...overrides,
  };
}

describe("mattermostPlugin", () => {
  beforeEach(() => {
    sendMessageMattermostMock.mockReset();
    sendMessageMattermostMock.mockResolvedValue({
      channelId: "channel-1",
      messageId: "post-1",
    });
  });

  describe("messaging", () => {
    it("keeps @username targets", () => {
      const normalize = requireMattermostNormalizeTarget();

      expect(normalize("@Alice")).toBe("@Alice");
      expect(normalize("@alice")).toBe("@alice");
    });

    it("normalizes spaced mattermost prefixes to user targets", () => {
      const normalize = requireMattermostNormalizeTarget();

      expect(normalize("mattermost:USER123")).toBe("user:USER123");
      expect(normalize("  mattermost:USER123  ")).toBe("user:USER123");
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = requireMattermostPairingNormalizer();

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
      expect(normalize("  @Alice  ")).toBe("alice");
      expect(normalize("  mattermost:USER123  ")).toBe("user123");
    });
  });

  describe("threading", () => {
    it("uses replyToMode for channel messages and keeps direct messages off", () => {
      const resolveReplyToMode = requireMattermostReplyToModeResolver();

      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            replyToMode: "all",
          },
        },
      };

      expect(
        resolveReplyToMode({
          accountId: "default",
          cfg,
          chatType: "channel",
        }),
      ).toBe("all");
      expect(
        resolveReplyToMode({
          accountId: "default",
          cfg,
          chatType: "direct",
        }),
      ).toBe("off");
    });

    it("uses configured defaultAccount when accountId is omitted", () => {
      const resolveReplyToMode = requireMattermostReplyToModeResolver();

      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            accounts: {
              alerts: {
                baseUrl: "https://alerts.example.com",
                botToken: "alerts-token",
                replyToMode: "all",
              },
            },
            defaultAccount: "alerts",
            replyToMode: "off",
          },
        },
      };

      expect(
        resolveReplyToMode({
          cfg,
          chatType: "channel",
        }),
      ).toBe("all");
    });
  });

  describe("messageActions", () => {
    beforeEach(() => {
      resetMattermostReactionBotUserCacheForTests();
    });

    const runReactAction = async (params: Record<string, unknown>, fetchMode: "add" | "remove") => {
      const cfg = createMattermostTestConfig();
      const fetchImpl = createMattermostReactionFetchMock({
        emojiName: "thumbsup",
        mode: fetchMode,
        postId: "POST1",
      });

      return await withMockedGlobalFetch(fetchImpl, async () => await mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            accountId: "default",
            action: "react",
            cfg,
            params,
          }),
        ));
    };

    it("exposes react when mattermost is configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: "test-token",
            enabled: true,
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toContain("react");
      expect(actions).toContain("send");
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "react" })).toBe(true);
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
    });

    it("hides react when mattermost is not configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toEqual([]);
    });

    it("keeps buttons optional in message tool schema", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: "test-token",
            enabled: true,
          },
        },
      };

      const discovery = mattermostPlugin.actions?.describeMessageTool?.({ cfg });
      const schema = discovery?.schema;
      if (!schema || Array.isArray(schema)) {
        throw new Error("expected mattermost message-tool schema");
      }

      expect(Type.Object(schema.properties).required).toBeUndefined();
    });

    it("hides react when actions.reactions is false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            actions: { reactions: false },
            baseUrl: "https://chat.example.com",
            botToken: "test-token",
            enabled: true,
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).not.toContain("react");
      expect(actions).toContain("send");
    });

    it("respects per-account actions.reactions in message discovery", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            accounts: {
              default: {
                actions: { reactions: true },
                baseUrl: "https://chat.example.com",
                botToken: "test-token",
                enabled: true,
              },
            },
            actions: { reactions: false },
            enabled: true,
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toContain("react");
    });

    it("honors the selected Mattermost account during discovery", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            accounts: {
              default: {
                actions: { reactions: false },
                baseUrl: "https://chat.example.com",
                botToken: "test-token",
                enabled: true,
              },
              work: {
                actions: { reactions: true },
                baseUrl: "https://chat.example.com",
                botToken: "work-token",
                enabled: true,
              },
            },
            actions: { reactions: false },
            enabled: true,
          },
        },
      };

      expect(getDescribedActions(cfg, "default")).toEqual(["send"]);
      expect(getDescribedActions(cfg, "work")).toEqual(["send", "react"]);
    });

    it("blocks react when default account disables reactions and accountId is omitted", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            accounts: {
              default: {
                actions: { reactions: false },
                baseUrl: "https://chat.example.com",
                botToken: "test-token",
                enabled: true,
              },
            },
            actions: { reactions: true },
            enabled: true,
          },
        },
      };

      await expect(
        mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "react",
            cfg,
            params: { emoji: "thumbsup", messageId: "POST1" },
          }),
        ),
      ).rejects.toThrow("Mattermost reactions are disabled in config");
    });

    it("handles react by calling Mattermost reactions API", async () => {
      const result = await runReactAction({ emoji: "thumbsup", messageId: "POST1" }, "add");

      expect(result?.content).toEqual([{ text: "Reacted with :thumbsup: on POST1", type: "text" }]);
      expect(result?.details).toEqual({});
    });

    it("only treats boolean remove flag as removal", async () => {
      const result = await runReactAction(
        { emoji: "thumbsup", messageId: "POST1", remove: "true" },
        "add",
      );

      expect(result?.content).toEqual([{ text: "Reacted with :thumbsup: on POST1", type: "text" }]);
    });

    it("removes reaction when remove flag is boolean true", async () => {
      const result = await runReactAction(
        { emoji: "thumbsup", messageId: "POST1", remove: true },
        "remove",
      );

      expect(result?.content).toEqual([
        { text: "Removed reaction :thumbsup: from POST1", type: "text" },
      ]);
      expect(result?.details).toEqual({});
    });

    it("maps replyTo to replyToId for send actions", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          accountId: "default",
          action: "send",
          cfg,
          params: {
            message: "hello",
            replyTo: "post-root",
            to: "channel:CHAN1",
          },
        }),
      );

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });

    it("falls back to trimmed replyTo when replyToId is blank", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          accountId: "default",
          action: "send",
          cfg,
          params: {
            message: "hello",
            replyTo: " post-root ",
            replyToId: "   ",
            to: "channel:CHAN1",
          },
        }),
      );

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });
  });

  describe("outbound", () => {
    it("chunks outbound text without requiring Mattermost runtime initialization", () => {
      const chunker = requireMattermostChunker();

      expect(() => chunker("hello world", 5)).not.toThrow();
      expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
    });

    it("forwards mediaLocalRoots on sendMedia", async () => {
      const sendMedia = requireMattermostSendMedia();
      const cfg = createMattermostTestConfig();

      const params: MattermostSendMediaParams = {
        accountId: "default",
        cfg,
        mediaLocalRoots: ["/tmp/workspace"],
        mediaUrl: "/tmp/workspace/image.png",
        replyToId: "post-root",
        text: "hello",
        to: "channel:CHAN1",
      };

      await sendMedia(params);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          mediaLocalRoots: ["/tmp/workspace"],
          mediaUrl: "/tmp/workspace/image.png",
        }),
      );
    });

    it("threads resolved cfg on sendText", async () => {
      const sendText = requireMattermostSendText();
      const cfg = {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: "resolved-bot-token",
          },
        },
      } as OpenClawConfig;

      const params: MattermostSendTextParams = {
        accountId: "default",
        cfg,
        text: "hello",
        to: "channel:CHAN1",
      };

      await sendText(params);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          accountId: "default",
          cfg,
        }),
      );
    });

    it("uses threadId as fallback when replyToId is absent (sendText)", async () => {
      const sendText = requireMattermostSendText();
      const cfg = createMattermostTestConfig();

      const params: MattermostSendTextParams = {
        accountId: "default",
        cfg,
        text: "hello",
        threadId: "post-root",
        to: "channel:CHAN1",
      };

      await sendText(params);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });

    it("uses threadId as fallback when replyToId is absent (sendMedia)", async () => {
      const sendMedia = requireMattermostSendMedia();
      const cfg = createMattermostTestConfig();

      const params: MattermostSendMediaParams = {
        accountId: "default",
        cfg,
        mediaUrl: "https://example.com/image.png",
        text: "caption",
        threadId: "post-root",
        to: "channel:CHAN1",
      };

      await sendMedia(params);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "caption",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = mattermostPlugin.config.formatAllowFrom!;

      const formatted = formatAllowFrom({
        allowFrom: [" @Alice ", " user:USER123 ", " mattermost:BOT999 "],
        cfg: {} as OpenClawConfig,
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            accounts: {
              default: { responsePrefix: "[Account]" },
            },
            responsePrefix: "[Channel]",
          },
        },
      };

      const prefixContext = createChannelReplyPipeline({
        accountId: "default",
        agentId: "main",
        cfg,
        channel: "mattermost",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });
  });
});
