import type { RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { withServer } from "../../../test/helpers/http-test-server.js";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import {
  createImageLifecycleCore,
  createImageUpdate,
  createTextUpdate,
  expectImageLifecycleDelivery,
  postWebhookReplay,
} from "../test-support/lifecycle-test-support.js";
import { handleZaloWebhookRequest } from "./monitor.js";
import {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
  registerZaloWebhookTarget,
} from "./monitor.webhook.js";
import type { ResolvedZaloAccount } from "./types.js";
const DEFAULT_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  config: {},
  enabled: true,
  token: "tok",
  tokenSource: "config",
};

const webhookRequestHandler: RequestListener = async (req, res) => {
  const handled = await handleZaloWebhookRequest(req, res);
  if (!handled) {
    res.statusCode = 404;
    res.end("not found");
  }
};

function registerTarget(params: {
  path: string;
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  account?: ResolvedZaloAccount;
  config?: OpenClawConfig;
  core?: PluginRuntime;
}): () => void {
  return registerZaloWebhookTarget({
    account: params.account ?? DEFAULT_ACCOUNT,
    config: params.config ?? ({} as OpenClawConfig),
    core: params.core ?? ({} as PluginRuntime),
    mediaMaxMb: 5,
    path: params.path,
    runtime: {},
    secret: params.secret ?? "secret",
    statusSink: params.statusSink,
    token: "tok",
  });
}

function createPairingAuthCore(params?: { storeAllowFrom?: string[]; pairingCreated?: boolean }): {
  core: PluginRuntime;
  readAllowFromStore: ReturnType<typeof vi.fn>;
  upsertPairingRequest: ReturnType<typeof vi.fn>;
} {
  const readAllowFromStore = vi.fn().mockResolvedValue(params?.storeAllowFrom ?? []);
  const upsertPairingRequest = vi
    .fn()
    .mockResolvedValue({ code: "PAIRCODE", created: params?.pairingCreated ?? false });
  const core = {
    channel: {
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        shouldComputeCommandAuthorized: vi.fn(() => false),
      },
      pairing: {
        buildPairingReply: vi.fn(() => "Pairing code: PAIRCODE"),
        readAllowFromStore,
        upsertPairingRequest,
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;
  return { core, readAllowFromStore, upsertPairingRequest };
}

async function postUntilRateLimited(params: {
  baseUrl: string;
  path: string;
  secret: string;
  withNonceQuery?: boolean;
  attempts?: number;
}): Promise<boolean> {
  const attempts = params.attempts ?? 130;
  for (let i = 0; i < attempts; i += 1) {
    const url = params.withNonceQuery
      ? `${params.baseUrl}${params.path}?nonce=${i}`
      : `${params.baseUrl}${params.path}`;
    const response = await fetch(url, {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-bot-api-secret-token": params.secret,
      },
      method: "POST",
    });
    if (response.status === 429) {
      return true;
    }
  }
  return false;
}

describe("handleZaloWebhookRequest", () => {
  afterEach(() => {
    clearZaloWebhookSecurityStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("returns 400 for non-object payloads", async () => {
    const unregister = registerTarget({ path: "/hook" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook`, {
          body: "null",
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Bad Request");
      });
    } finally {
      unregister();
    }
  });

  it("rejects ambiguous routing when multiple targets match the same secret", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const unregisterA = registerTarget({ path: "/hook", statusSink: sinkA });
    const unregisterB = registerTarget({ path: "/hook", statusSink: sinkB });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook`, {
          body: "{}",
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(response.status).toBe(401);
        expect(sinkA).not.toHaveBeenCalled();
        expect(sinkB).not.toHaveBeenCalled();
      });
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("returns 415 for non-json content-type", async () => {
    const unregister = registerTarget({ path: "/hook-content-type" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-content-type`, {
          body: "{}",
          headers: {
            "content-type": "text/plain",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(response.status).toBe(415);
      });
    } finally {
      unregister();
    }
  });

  it("deduplicates webhook replay for the same event origin", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay", statusSink: sink });
    const payload = createTextUpdate({
      chatId: "123",
      messageId: "msg-replay-1",
      text: "hello",
      userId: "123",
      userName: "",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const { first, replay } = await postWebhookReplay({
          baseUrl,
          path: "/hook-replay",
          payload,
          secret: "secret",
        });

        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);
        expect(sink).toHaveBeenCalledTimes(1);
      });
    } finally {
      unregister();
    }
  });
  it("keeps replay dedupe isolated per authenticated target", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const unregisterA = registerTarget({
      path: "/hook-replay-scope",
      secret: "secret-a",
      statusSink: sinkA,
    });
    const unregisterB = registerTarget({
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "work",
      },
      path: "/hook-replay-scope",
      secret: "secret-b",
      statusSink: sinkB,
    });
    const payload = createTextUpdate({
      chatId: "123",
      messageId: "msg-replay-scope-1",
      text: "hello",
      userId: "123",
      userName: "",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const first = await fetch(`${baseUrl}/hook-replay-scope`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret-a",
          },
          method: "POST",
        });
        const second = await fetch(`${baseUrl}/hook-replay-scope`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret-b",
          },
          method: "POST",
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
      });

      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("does not collide replay dedupe across different chats", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay-chat-scope", statusSink: sink });
    const firstPayload = createTextUpdate({
      chatId: "chat-a",
      messageId: "msg-replay-chat-1",
      text: "hello from a",
      userId: "123",
      userName: "",
    });
    const secondPayload = createTextUpdate({
      chatId: "chat-b",
      messageId: "msg-replay-chat-1",
      text: "hello from b",
      userId: "123",
      userName: "",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const first = await fetch(`${baseUrl}/hook-replay-chat-scope`, {
          body: JSON.stringify(firstPayload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });
        const second = await fetch(`${baseUrl}/hook-replay-chat-scope`, {
          body: JSON.stringify(secondPayload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
      });

      expect(sink).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });

  it("does not collide replay dedupe across different senders in the same chat", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay-sender-scope", statusSink: sink });
    const firstPayload = createTextUpdate({
      chatId: "chat-shared",
      messageId: "msg-replay-sender-1",
      text: "hello from user a",
      userId: "user-a",
      userName: "",
    });
    const secondPayload = createTextUpdate({
      chatId: "chat-shared",
      messageId: "msg-replay-sender-1",
      text: "hello from user b",
      userId: "user-b",
      userName: "",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const first = await fetch(`${baseUrl}/hook-replay-sender-scope`, {
          body: JSON.stringify(firstPayload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });
        const second = await fetch(`${baseUrl}/hook-replay-sender-scope`, {
          body: JSON.stringify(secondPayload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
      });

      expect(sink).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });

  it("does not throw when replay metadata is partially missing", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay-partial", statusSink: sink });
    const payload = {
      event_name: "message.text.received",
      message: {
        date: Math.floor(Date.now() / 1000),
        message_id: "msg-replay-partial-1",
        text: "hello",
      },
    };

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-replay-partial`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(response.status).toBe(200);
      });

      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("keeps replay dedupe isolated when path/account values collide under colon-joined keys", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    // Old key format `${path}:${accountId}:${event_name}:${messageId}` would collide for these two targets.
    const unregisterA = registerTarget({
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "team",
      },
      path: "/hook-replay-collision:a",
      secret: "secret-a",
      statusSink: sinkA,
    });
    const unregisterB = registerTarget({
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "a:team",
      },
      path: "/hook-replay-collision",
      secret: "secret-b",
      statusSink: sinkB,
    });
    const payload = createTextUpdate({
      chatId: "123",
      messageId: "msg-replay-collision-1",
      text: "hello",
      userId: "123",
      userName: "",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const first = await fetch(`${baseUrl}/hook-replay-collision:a`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret-a",
          },
          method: "POST",
        });
        const second = await fetch(`${baseUrl}/hook-replay-collision`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret-b",
          },
          method: "POST",
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
      });

      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("keeps replay dedupe isolated across different webhook paths", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const sharedSecret = "secret";
    const unregisterA = registerTarget({
      path: "/hook-replay-scope-a",
      secret: sharedSecret,
      statusSink: sinkA,
    });
    const unregisterB = registerTarget({
      path: "/hook-replay-scope-b",
      secret: sharedSecret,
      statusSink: sinkB,
    });
    const payload = createTextUpdate({
      chatId: "123",
      messageId: "msg-replay-cross-path-1",
      text: "hello",
      userId: "123",
      userName: "",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const first = await fetch(`${baseUrl}/hook-replay-scope-a`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": sharedSecret,
          },
          method: "POST",
        });
        const second = await fetch(`${baseUrl}/hook-replay-scope-b`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": sharedSecret,
          },
          method: "POST",
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
      });

      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("downloads inbound image media from webhook photo_url and preserves display_name", async () => {
    const {
      core,
      finalizeInboundContextMock,
      recordInboundSessionMock,
      fetchRemoteMediaMock,
      saveMediaBufferMock,
    } = createImageLifecycleCore();
    const unregister = registerTarget({
      account: {
        ...DEFAULT_ACCOUNT,
        config: {
          dmPolicy: "open",
        },
      },
      core,
      path: "/hook-image",
    });
    const payload = createImageUpdate();

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-image`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(response.status).toBe(200);
      });
    } finally {
      unregister();
    }

    await vi.waitFor(() => expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1));
    expectImageLifecycleDelivery({
      fetchRemoteMediaMock,
      finalizeInboundContextMock,
      recordInboundSessionMock,
      saveMediaBufferMock,
    });
  });

  it("returns 429 when per-path request rate exceeds threshold", async () => {
    const unregister = registerTarget({ path: "/hook-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-rate",
          secret: "secret", // Pragma: allowlist secret
        });

        expect(saw429).toBe(true);
      });
    } finally {
      unregister();
    }
  });
  it("does not grow status counters when query strings churn on unauthorized requests", async () => {
    const unregister = registerTarget({ path: "/hook-query-status" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        let saw429 = false;
        for (let i = 0; i < 200; i += 1) {
          const response = await fetch(`${baseUrl}/hook-query-status?nonce=${i}`, {
            body: "{}",
            headers: {
              "x-bot-api-secret-token": "invalid-token", // Pragma: allowlist secret
              "content-type": "application/json",
            },
            method: "POST",
          });
          expect([401, 429]).toContain(response.status);
          if (response.status === 429) {
            saw429 = true;
            break;
          }
        }

        expect(saw429).toBe(true);
        expect(getZaloWebhookStatusCounterSizeForTest()).toBe(2);
      });
    } finally {
      unregister();
    }
  });

  it("rate limits authenticated requests even when query strings churn", async () => {
    const unregister = registerTarget({ path: "/hook-query-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-query-rate",
          secret: "secret", // Pragma: allowlist secret
          withNonceQuery: true,
        });

        expect(saw429).toBe(true);
        expect(getZaloWebhookRateLimitStateSizeForTest()).toBe(1);
      });
    } finally {
      unregister();
    }
  });

  it("rate limits unauthorized secret guesses before authentication succeeds", async () => {
    const unregister = registerTarget({ path: "/hook-preauth-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-preauth-rate",
          secret: "invalid-token", // Pragma: allowlist secret
          withNonceQuery: true,
        });

        expect(saw429).toBe(true);
        expect(getZaloWebhookRateLimitStateSizeForTest()).toBe(1);
      });
    } finally {
      unregister();
    }
  });

  it("does not let unauthorized floods rate-limit authenticated traffic from a different trusted forwarded client IP", async () => {
    const unregister = registerTarget({
      config: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      } as OpenClawConfig,
      path: "/hook-preauth-split",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        for (let i = 0; i < 130; i += 1) {
          const response = await fetch(`${baseUrl}/hook-preauth-split?nonce=${i}`, {
            body: "{}",
            headers: {
              "x-bot-api-secret-token": "invalid-token", // Pragma: allowlist secret
              "content-type": "application/json",
              "x-forwarded-for": "203.0.113.10",
            },
            method: "POST",
          });
          if (response.status === 429) {
            break;
          }
        }

        const validResponse = await fetch(`${baseUrl}/hook-preauth-split`, {
          body: JSON.stringify({ event_name: "message.unsupported.received" }),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
            "x-forwarded-for": "198.51.100.20",
          },
          method: "POST",
        });

        expect(validResponse.status).toBe(200);
      });
    } finally {
      unregister();
    }
  });

  it("still returns 401 before 415 when both secret and content-type are invalid", async () => {
    const unregister = registerTarget({ path: "/hook-auth-before-type" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-auth-before-type`, {
          body: "not-json",
          headers: {
            "x-bot-api-secret-token": "invalid-token", // Pragma: allowlist secret
            "content-type": "text/plain",
          },
          method: "POST",
        });

        expect(response.status).toBe(401);
      });
    } finally {
      unregister();
    }
  });

  it("scopes DM pairing store reads and writes to accountId", async () => {
    const { core, readAllowFromStore, upsertPairingRequest } = createPairingAuthCore({
      pairingCreated: false,
    });
    const account: ResolvedZaloAccount = {
      ...DEFAULT_ACCOUNT,
      accountId: "work",
      config: {
        allowFrom: [],
        dmPolicy: "pairing",
      },
    };
    const unregister = registerTarget({
      account,
      core,
      path: "/hook-account-scope",
    });

    const payload = {
      event_name: "message.text.received",
      message: {
        chat: { chat_type: "PRIVATE", id: "dm-work" },
        date: Math.floor(Date.now() / 1000),
        from: { id: "123", name: "Attacker" },
        message_id: "msg-work-1",
        text: "hello",
      },
    };

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-account-scope`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "secret",
          },
          method: "POST",
        });

        expect(response.status).toBe(200);
      });
    } finally {
      unregister();
    }

    expect(readAllowFromStore).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "zalo",
      }),
    );
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "zalo",
        id: "123",
      }),
    );
  });
});
