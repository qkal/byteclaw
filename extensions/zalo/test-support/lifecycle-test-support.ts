import { request as httpRequest } from "node:http";
import { expect, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "../src/types.js";

export function createLifecycleConfig(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}): OpenClawConfig {
  const webhookUrl = params.webhookUrl ?? "https://example.com/hooks/zalo";
  const webhookSecret = params.webhookSecret ?? "supersecret";
  return {
    channels: {
      zalo: {
        accounts: {
          [params.accountId]: {
            enabled: true,
            webhookUrl,
            webhookSecret, // Pragma: allowlist secret
            dmPolicy: params.dmPolicy,
            ...(params.allowFrom ? { allowFrom: params.allowFrom } : {}),
          },
        },
        enabled: true,
      },
    },
  } as OpenClawConfig;
}

export function createLifecycleAccount(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}): ResolvedZaloAccount {
  const webhookUrl = params.webhookUrl ?? "https://example.com/hooks/zalo";
  const webhookSecret = params.webhookSecret ?? "supersecret";
  return {
    accountId: params.accountId,
    config: {
      webhookUrl,
      webhookSecret, // Pragma: allowlist secret
      dmPolicy: params.dmPolicy,
      ...(params.allowFrom ? { allowFrom: params.allowFrom } : {}),
    },
    enabled: true,
    token: "zalo-token",
    tokenSource: "config",
  } as ResolvedZaloAccount;
}

export function createLifecycleMonitorSetup(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}) {
  return {
    account: createLifecycleAccount(params),
    config: createLifecycleConfig(params),
  };
}

export function createTextUpdate(params: {
  messageId: string;
  userId: string;
  userName: string;
  chatId: string;
  text?: string;
}) {
  return {
    event_name: "message.text.received",
    message: {
      chat: { chat_type: "PRIVATE" as const, id: params.chatId },
      date: Math.floor(Date.now() / 1000),
      from: { id: params.userId, name: params.userName },
      message_id: params.messageId,
      text: params.text ?? "hello from zalo",
    },
  };
}

export function createImageUpdate(params?: {
  messageId?: string;
  userId?: string;
  displayName?: string;
  chatId?: string;
  photoUrl?: string;
  date?: number;
}) {
  return {
    event_name: "message.image.received",
    message: {
      caption: "",
      chat: { chat_type: "PRIVATE" as const, id: params?.chatId ?? "chat-123" },
      date: params?.date ?? 1_774_086_023_728,
      from: {
        display_name: params?.displayName ?? "Test User",
        id: params?.userId ?? "user-123",
        is_bot: false,
      },
      message_id: params?.messageId ?? "msg-123",
      message_type: "CHAT_PHOTO",
      photo_url: params?.photoUrl ?? "https://example.com/test-image.jpg",
    },
  };
}

export function createImageLifecycleCore() {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const fetchRemoteMediaMock = vi.fn(async () => ({
    buffer: Buffer.from("image-bytes"),
    contentType: "image/jpeg",
  }));
  const saveMediaBufferMock = vi.fn(async () => ({
    contentType: "image/jpeg",
    path: "/tmp/zalo-photo.jpg",
  }));
  const readAllowFromStoreMock = vi.fn(async () => [] as string[]);
  const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRCODE", created: true }));
  const core = {
    channel: {
      commands: {
        isControlCommandMessage: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["isControlCommandMessage"],
        resolveCommandAuthorizedFromAuthorizers: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"],
        shouldComputeCommandAuthorized: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"],
      },
      media: {
        fetchRemoteMedia:
          fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
        saveMediaBuffer:
          saveMediaBufferMock as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
      },
      pairing: {
        readAllowFromStore:
          readAllowFromStoreMock as unknown as PluginRuntime["channel"]["pairing"]["readAllowFromStore"],
        upsertPairingRequest:
          upsertPairingRequestMock as unknown as PluginRuntime["channel"]["pairing"]["upsertPairingRequest"],
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async () => undefined,
        ) as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        formatAgentEnvelope: vi.fn(
          (opts: { body: string }) => opts.body,
        ) as unknown as PluginRuntime["channel"]["reply"]["formatAgentEnvelope"],
        resolveEnvelopeFormatOptions: vi.fn(() => ({
          template: "channel+name+time",
        })) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          accountId: "default",
          agentId: "main",
          sessionKey: "agent:main:zalo:direct:chat-123",
        })) as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      session: {
        readSessionUpdatedAt: vi.fn(
          () => undefined,
        ) as unknown as PluginRuntime["channel"]["session"]["readSessionUpdatedAt"],
        recordInboundSession:
          recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
        resolveStorePath: vi.fn(
          () => "/tmp/zalo-sessions.json",
        ) as unknown as PluginRuntime["channel"]["session"]["resolveStorePath"],
      },
      text: {
        resolveMarkdownTableMode: vi.fn(
          () => "code",
        ) as unknown as PluginRuntime["channel"]["text"]["resolveMarkdownTableMode"],
      },
    },
    logging: {
      shouldLogVerbose: vi.fn(
        () => false,
      ) as unknown as PluginRuntime["logging"]["shouldLogVerbose"],
    },
  } as PluginRuntime;
  return {
    core,
    fetchRemoteMediaMock,
    finalizeInboundContextMock,
    readAllowFromStoreMock,
    recordInboundSessionMock,
    saveMediaBufferMock,
    upsertPairingRequestMock,
  };
}

export function expectImageLifecycleDelivery(params: {
  fetchRemoteMediaMock: ReturnType<typeof vi.fn>;
  saveMediaBufferMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  recordInboundSessionMock: ReturnType<typeof vi.fn>;
  photoUrl?: string;
  senderName?: string;
  mediaPath?: string;
  mediaType?: string;
}) {
  const photoUrl = params.photoUrl ?? "https://example.com/test-image.jpg";
  const senderName = params.senderName ?? "Test User";
  const mediaPath = params.mediaPath ?? "/tmp/zalo-photo.jpg";
  const mediaType = params.mediaType ?? "image/jpeg";
  expect(params.fetchRemoteMediaMock).toHaveBeenCalledWith({
    maxBytes: 5 * 1024 * 1024,
    url: photoUrl,
  });
  expect(params.saveMediaBufferMock).toHaveBeenCalledTimes(1);
  expect(params.finalizeInboundContextMock).toHaveBeenCalledWith(
    expect.objectContaining({
      MediaPath: mediaPath,
      MediaType: mediaType,
      SenderName: senderName,
    }),
  );
  expect(params.recordInboundSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ctx: expect.objectContaining({
        MediaPath: mediaPath,
        MediaType: mediaType,
        SenderName: senderName,
      }),
    }),
  );
}

export async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function postWebhookUpdate(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
}) {
  const url = new URL(params.path, params.baseUrl);
  const body = JSON.stringify(params.payload);
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        headers: {
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          "x-bot-api-secret-token": params.secret,
        },
        method: "POST",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function postWebhookReplay(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
  settleBeforeReplay?: boolean;
}) {
  const first = await postWebhookUpdate(params);
  if (params.settleBeforeReplay) {
    await settleAsyncWork();
  }
  const replay = await postWebhookUpdate(params);
  return { first, replay };
}
