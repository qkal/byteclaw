import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/plugins/directory.ts";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  googlechatDirectoryAdapter,
  googlechatOutboundAdapter,
  googlechatPairingTextAdapter,
  googlechatSecurityAdapter,
  googlechatThreadingAdapter,
} from "./channel.adapters.js";

const uploadGoogleChatAttachmentMock = vi.hoisted(() => vi.fn());
const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccountMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpaceMock = vi.hoisted(() => vi.fn());
const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
const probeGoogleChatMock = vi.hoisted(() => vi.fn());
const startGoogleChatMonitorMock = vi.hoisted(() => vi.fn());

const DEFAULT_ACCOUNT_ID = "default";

function normalizeGoogleChatTarget(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "");
  const normalized = withoutPrefix
    .replace(/^user:(users\/)?/i, "users/")
    .replace(/^space:(spaces\/)?/i, "spaces/");
  if (normalized.toLowerCase().startsWith("users/")) {
    const suffix = normalized.slice("users/".length);
    return suffix.includes("@") ? `users/${suffix.toLowerCase()}` : normalized;
  }
  if (normalized.toLowerCase().startsWith("spaces/")) {
    return normalized;
  }
  if (normalized.includes("@")) {
    return `users/${normalized.toLowerCase()}`;
  }
  return normalized;
}

function resolveGoogleChatAccountImpl(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const channelConfig = (params.cfg.channels?.googlechat ?? {}) as Record<string, unknown>;
  const accounts =
    (channelConfig.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
  const scoped = accountId === DEFAULT_ACCOUNT_ID ? {} : (accounts[accountId] ?? {});
  const config = { ...channelConfig, ...scoped } as Record<string, unknown>;
  const { serviceAccount } = config;
  return {
    accountId,
    config,
    credentialSource: serviceAccount ? ("inline" as const) : ("none" as const),
    enabled: channelConfig.enabled !== false && scoped.enabled !== false,
    name: typeof config.name === "string" ? config.name : undefined,
  };
}

function mockGoogleChatOutboundSpaceResolution() {
  resolveGoogleChatOutboundSpaceMock.mockImplementation(async ({ target }: { target: string }) => {
    const normalized = normalizeGoogleChatTarget(target);
    if (!normalized) {
      throw new Error("Missing Google Chat target.");
    }
    return normalized.toLowerCase().startsWith("users/")
      ? `spaces/DM-${normalized.slice("users/".length)}`
      : normalized.replace(/\/messages\/.+$/, "");
  });
}

function mockGoogleChatMediaLoaders() {
  loadOutboundMediaFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
    buffer: Buffer.from("default-bytes"),
    contentType: "application/octet-stream",
    fileName: mediaUrl.split("/").pop() || "attachment",
  }));
  fetchRemoteMediaMock.mockImplementation(async () => ({
    buffer: Buffer.from("remote-bytes"),
    contentType: "image/png",
    fileName: "remote.png",
  }));
}

vi.mock("./channel.runtime.js", () => ({
  googleChatChannelRuntime: {
    probeGoogleChat: (...args: unknown[]) => probeGoogleChatMock(...args),
    resolveGoogleChatWebhookPath: () => "/googlechat/webhook",
    sendGoogleChatMessage: (...args: unknown[]) => sendGoogleChatMessageMock(...args),
    startGoogleChatMonitor: (...args: unknown[]) => startGoogleChatMonitorMock(...args),
    uploadGoogleChatAttachment: (...args: unknown[]) => uploadGoogleChatAttachmentMock(...args),
  },
}));

vi.mock("./channel.deps.runtime.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  GoogleChatConfigSchema: {},
  PAIRING_APPROVED_MESSAGE: "approved",
  buildChannelConfigSchema: () => ({}),
  chunkTextForOutbound: (text: string, maxChars: number) => {
    const words = text.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (current && next.length > maxChars) {
        chunks.push(current);
        current = word;
        continue;
      }
      current = next;
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  },
  createAccountStatusSink: () => () => {},
  fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMediaMock(...args),
  getChatChannelMeta: (id: string) => ({ id, name: id }),
  isGoogleChatSpaceTarget: (value: string) => value.toLowerCase().startsWith("spaces/"),
  isGoogleChatUserTarget: (value: string) => value.toLowerCase().startsWith("users/"),
  listGoogleChatAccountIds: (cfg: OpenClawConfig) => {
    const ids = Object.keys(cfg.channels?.googlechat?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  loadOutboundMediaFromUrl: (...args: unknown[]) => loadOutboundMediaFromUrlMock(...args),
  missingTargetError: (channel: string, hint: string) =>
    new Error(`${channel} target is required (${hint})`),
  normalizeGoogleChatTarget,
  resolveChannelMediaMaxBytes: (params: {
    cfg: OpenClawConfig;
    resolveChannelLimitMb: (args: {
      cfg: OpenClawConfig;
      accountId?: string;
    }) => number | undefined;
    accountId?: string;
  }) => {
    const limitMb = params.resolveChannelLimitMb({
      cfg: params.cfg,
      accountId: params.accountId,
    });
    return typeof limitMb === "number" ? limitMb * 1024 * 1024 : undefined;
  },
  resolveDefaultGoogleChatAccountId: () => "default",
  resolveGoogleChatAccount: (...args: Parameters<typeof resolveGoogleChatAccountImpl>) =>
    resolveGoogleChatAccountMock(...args),
  resolveGoogleChatOutboundSpace: (...args: unknown[]) =>
    resolveGoogleChatOutboundSpaceMock(...args),
  runPassiveAccountLifecycle: async (params: { start: () => Promise<unknown> }) =>
    await params.start(),
}));

resolveGoogleChatAccountMock.mockImplementation(resolveGoogleChatAccountImpl);
mockGoogleChatOutboundSpaceResolution();
mockGoogleChatMediaLoaders();

afterEach(() => {
  vi.clearAllMocks();
  resolveGoogleChatAccountMock.mockImplementation(resolveGoogleChatAccountImpl);
  mockGoogleChatOutboundSpaceResolution();
  mockGoogleChatMediaLoaders();
});

function createGoogleChatCfg(): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        serviceAccount: {
          type: "service_account",
          client_email: "bot@example.com",
          private_key: "test-key", // Pragma: allowlist secret
          token_uri: "https://oauth2.googleapis.com/token",
        },
      },
    },
  };
}

function setupRuntimeMediaMocks(params: { loadFileName: string; loadBytes: string }) {
  const loadOutboundMediaFromUrl = vi.fn(async () => ({
    buffer: Buffer.from(params.loadBytes),
    contentType: "image/png",
    fileName: params.loadFileName,
  }));
  const fetchRemoteMedia = vi.fn(async () => ({
    buffer: Buffer.from("remote-bytes"),
    contentType: "image/png",
    fileName: "remote.png",
  }));

  loadOutboundMediaFromUrlMock.mockImplementation(loadOutboundMediaFromUrl);
  fetchRemoteMediaMock.mockImplementation(fetchRemoteMedia);

  return { fetchRemoteMedia, loadOutboundMediaFromUrl };
}

describe("googlechatPlugin outbound sendMedia", () => {
  it("chunks outbound text without requiring Google Chat runtime initialization", () => {
    const { chunker } = googlechatOutboundAdapter.base;

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("loads local media with mediaLocalRoots via runtime media loader", async () => {
    const { loadOutboundMediaFromUrl, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadBytes: "image-bytes",
      loadFileName: "image.png",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatOutboundAdapter.attachedResults.sendMedia({
      accountId: "default",
      cfg,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaUrl: "/tmp/workspace/image.png",
      text: "caption",
      to: "spaces/AAA",
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/image.png",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    );
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "image/png",
        filename: "image.png",
        space: "spaces/AAA",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toEqual({
      chatId: "spaces/AAA",
      messageId: "spaces/AAA/messages/msg-1",
    });
  });

  it("keeps remote URL media fetch on fetchRemoteMedia with maxBytes cap", async () => {
    const { loadOutboundMediaFromUrl, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadBytes: "should-not-be-used",
      loadFileName: "unused.png",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-2",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-2",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatOutboundAdapter.attachedResults.sendMedia({
      accountId: "default",
      cfg,
      mediaUrl: "https://example.com/image.png",
      text: "caption",
      to: "spaces/AAA",
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: 20 * 1024 * 1024,
        url: "https://example.com/image.png",
      }),
    );
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "image/png",
        filename: "remote.png",
        space: "spaces/AAA",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toEqual({
      chatId: "spaces/AAA",
      messageId: "spaces/AAA/messages/msg-2",
    });
  });
});

describe("googlechatPlugin threading", () => {
  it("honors per-account replyToMode overrides", () => {
    const cfg = {
      channels: {
        googlechat: {
          accounts: {
            work: {
              replyToMode: "first",
            },
          },
          replyToMode: "all",
        },
      },
    } as OpenClawConfig;

    const workAccount = googlechatThreadingAdapter.scopedAccountReplyToMode.resolveAccount(
      cfg,
      "work",
    );
    const defaultAccount = googlechatThreadingAdapter.scopedAccountReplyToMode.resolveAccount(
      cfg,
      "default",
    );

    expect(
      googlechatThreadingAdapter.scopedAccountReplyToMode.resolveReplyToMode(workAccount),
    ).toBe("first");
    expect(
      googlechatThreadingAdapter.scopedAccountReplyToMode.resolveReplyToMode(defaultAccount),
    ).toBe("all");
  });
});

const { resolveTarget } = googlechatOutboundAdapter.base;

describe("googlechatPlugin outbound resolveTarget", () => {
  it("resolves valid chat targets", () => {
    const result = resolveTarget({
      to: "spaces/AAA",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("spaces/AAA");
  });

  it("resolves email targets", () => {
    const result = resolveTarget({
      to: "user@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("users/user@example.com");
  });

  it("errors on invalid targets", () => {
    const result = resolveTarget({
      to: "   ",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid target to fail");
    }
    expect(result.error).toBeDefined();
  });

  it("errors when no target is provided", () => {
    const result = resolveTarget({
      to: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected missing target to fail");
    }
    expect(result.error).toBeDefined();
  });
});

describe("googlechatPlugin outbound cfg threading", () => {
  it("preserves accountId when sending pairing approvals", async () => {
    const cfg = {
      channels: {
        googlechat: {
          accounts: {
            work: {
              serviceAccount: {
                type: "service_account",
              },
            },
          },
          enabled: true,
        },
      },
    };
    const account = {
      accountId: "work",
      config: {},
      credentialSource: "inline" as const,
    };
    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/WORK");
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/WORK/messages/msg-1",
    });

    await googlechatPairingTextAdapter.notify({
      accountId: "work",
      cfg: cfg as never,
      id: "user@example.com",
      message: googlechatPairingTextAdapter.message,
    } as never);

    expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
      accountId: "work",
      cfg,
    });
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/WORK",
        text: expect.any(String),
      }),
    );
  });

  it("threads resolved cfg into sendText account resolution", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
          },
        },
      },
    };
    const account = {
      accountId: "default",
      config: {},
      credentialSource: "inline" as const,
    };
    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    await googlechatOutboundAdapter.attachedResults.sendText({
      accountId: "default",
      cfg: cfg as never,
      text: "hello",
      to: "users/123",
    });

    expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
    });
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        text: "hello",
      }),
    );
  });

  it("threads resolved cfg into sendMedia account and media loading path", async () => {
    const cfg = {
      channels: {
        googlechat: {
          mediaMaxMb: 8,
          serviceAccount: {
            type: "service_account",
          },
        },
      },
    };
    const account = {
      accountId: "default",
      config: { mediaMaxMb: 20 },
      credentialSource: "inline" as const,
    };
    const { fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadBytes: "should-not-be-used",
      loadFileName: "unused.png",
    });

    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-2",
    });

    await googlechatOutboundAdapter.attachedResults.sendMedia({
      accountId: "default",
      cfg: cfg as never,
      mediaUrl: "https://example.com/file.png",
      text: "photo",
      to: "users/123",
    });

    expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
    });
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: 8 * 1024 * 1024,
        url: "https://example.com/file.png",
      }),
    );
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        filename: "remote.png",
        space: "spaces/AAA",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        attachments: [{ attachmentUploadToken: "token-1", contentName: "remote.png" }],
      }),
    );
  });

  it("sends media without requiring Google Chat runtime initialization", async () => {
    const { loadOutboundMediaFromUrl } = setupRuntimeMediaMocks({
      loadBytes: "image-bytes",
      loadFileName: "image.png",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-cold",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-cold",
    });

    const cfg = createGoogleChatCfg();

    await expect(
      googlechatOutboundAdapter.attachedResults.sendMedia({
        accountId: "default",
        cfg,
        mediaLocalRoots: ["/tmp/workspace"],
        mediaUrl: "/tmp/workspace/image.png",
        text: "caption",
        to: "spaces/AAA",
      }),
    ).resolves.toEqual({
      chatId: "spaces/AAA",
      messageId: "spaces/AAA/messages/msg-cold",
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/image.png",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    );
  });
});

describe("googlechat directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        googlechat: {
          dm: { allowFrom: ["users/alice", "googlechat:bob"] },
          groups: {
            "spaces/AAA": {},
            "spaces/BBB": {},
          },
          serviceAccount: { client_email: "bot@example.com" },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatDirectoryAdapter);

    await expect(
      directory.listPeers({
        accountId: undefined,
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "users/alice", kind: "user" },
        { id: "bob", kind: "user" },
      ]),
    );

    await expect(
      directory.listGroups({
        accountId: undefined,
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "spaces/AAA", kind: "group" },
        { id: "spaces/BBB", kind: "group" },
      ]),
    );
  });

  it("normalizes spaced provider-prefixed dm allowlist entries", async () => {
    const cfg = {
      channels: {
        googlechat: {
          dm: { allowFrom: [" users/alice ", " googlechat:user:Bob@Example.com "] },
          serviceAccount: { client_email: "bot@example.com" },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatDirectoryAdapter);

    await expect(
      directory.listPeers({
        accountId: undefined,
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "users/alice", kind: "user" },
        { id: "users/bob@example.com", kind: "user" },
      ]),
    );
  });
});

describe("googlechatPlugin security", () => {
  it("normalizes prefixed DM allowlist entries to lowercase user ids", () => {
    const cfg = {
      channels: {
        googlechat: {
          dm: {
            allowFrom: ["  googlechat:user:Bob@Example.com  "],
            policy: "allowlist",
          },
          serviceAccount: { client_email: "bot@example.com" },
        },
      },
    } as OpenClawConfig;

    const account = resolveGoogleChatAccountImpl({ accountId: "default", cfg });

    expect(googlechatSecurityAdapter.dm.resolvePolicy(account)).toBe("allowlist");
    expect(googlechatSecurityAdapter.dm.resolveAllowFrom(account)).toEqual([
      "  googlechat:user:Bob@Example.com  ",
    ]);
    expect(googlechatSecurityAdapter.dm.normalizeEntry("  googlechat:user:Bob@Example.com  ")).toBe(
      "bob@example.com",
    );
    expect(googlechatPairingTextAdapter.normalizeAllowEntry("  users/Alice@Example.com  ")).toBe(
      "alice@example.com",
    );
  });
});
