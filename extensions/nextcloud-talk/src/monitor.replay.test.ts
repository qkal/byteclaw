import { describe, expect, it, vi } from "vitest";
import { createMockIncomingRequest } from "../../../test/helpers/mock-incoming-request.js";
import { WEBHOOK_RATE_LIMIT_DEFAULTS } from "../runtime-api.js";
import { readNextcloudTalkWebhookBody } from "./monitor.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

describe("readNextcloudTalkWebhookBody", () => {
  it("reads valid body within max bytes", async () => {
    const req = createMockIncomingRequest(['{"type":"Create"}']);
    const body = await readNextcloudTalkWebhookBody(req, 1024);
    expect(body).toBe('{"type":"Create"}');
  });

  it("rejects when payload exceeds max bytes", async () => {
    const req = createMockIncomingRequest(["x".repeat(300)]);
    await expect(readNextcloudTalkWebhookBody(req, 128)).rejects.toThrow("PayloadTooLarge");
  });
});

describe("createNextcloudTalkWebhookServer auth order", () => {
  it("rejects missing signature headers before reading request body", async () => {
    const readBody = vi.fn(async () => {
      throw new Error("should not be called for missing signature headers");
    });
    const harness = await startWebhookServer({
      maxBodyBytes: 128,
      onMessage: vi.fn(),
      path: "/nextcloud-auth-order",
      readBody,
    });

    const response = await fetch(harness.webhookUrl, {
      body: "{}",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing signature headers" });
    expect(readBody).not.toHaveBeenCalled();
  });
});

describe("createNextcloudTalkWebhookServer backend allowlist", () => {
  it("rejects requests from unexpected backend origins", async () => {
    const onMessage = vi.fn(async () => {});
    const harness = await startWebhookServer({
      isBackendAllowed: (backend) => backend === "https://nextcloud.expected",
      onMessage,
      path: "/nextcloud-backend-check",
    });

    const { body, headers } = createSignedCreateMessageRequest({
      backend: "https://nextcloud.unexpected",
    });
    const response = await fetch(harness.webhookUrl, {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid backend" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("createNextcloudTalkWebhookServer replay handling", () => {
  it("acknowledges replayed requests and skips onMessage side effects", async () => {
    const seen = new Set<string>();
    const onMessage = vi.fn(async () => {});
    const shouldProcessMessage = vi.fn(async (message: NextcloudTalkInboundMessage) => {
      if (seen.has(message.messageId)) {
        return false;
      }
      seen.add(message.messageId);
      return true;
    });
    const harness = await startWebhookServer({
      onMessage,
      path: "/nextcloud-replay",
      shouldProcessMessage,
    });

    const { body, headers } = createSignedCreateMessageRequest();

    const first = await fetch(harness.webhookUrl, {
      body,
      headers,
      method: "POST",
    });
    const second = await fetch(harness.webhookUrl, {
      body,
      headers,
      method: "POST",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(shouldProcessMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

describe("createNextcloudTalkWebhookServer payload validation", () => {
  it("rejects malformed webhook payloads after signature verification", async () => {
    const payload = {
      actor: { id: "alice", name: "Alice", type: "Person" },
      object: {
        content: "hello",
        id: "msg-1",
        mediaType: "text/plain",
        name: "hello",
        type: "Note",
      },
      target: { id: "", name: "Room 1", type: "Collection" },
      type: "Create",
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret", // Pragma: allowlist secret
    });
    const harness = await startWebhookServer({
      onMessage: vi.fn(),
      path: "/nextcloud-invalid-payload",
    });

    const response = await fetch(harness.webhookUrl, {
      body,
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-backend": "https://nextcloud.example",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid payload format" });
  });
});

describe("createNextcloudTalkWebhookServer auth rate limiting", () => {
  it("rate limits repeated invalid signature attempts from the same source", async () => {
    const harness = await startWebhookServer({
      onMessage: vi.fn(),
      path: "/nextcloud-auth-rate-limit",
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const invalidHeaders = {
      ...headers,
      "x-nextcloud-talk-signature": "invalid-signature",
    };

    let firstResponse: Response | undefined;
    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests; attempt += 1) {
      const response = await fetch(harness.webhookUrl, {
        body,
        headers: invalidHeaders,
        method: "POST",
      });
      if (attempt === 0) {
        firstResponse = response;
      }
      lastResponse = response;
    }

    expect(firstResponse).toBeDefined();
    expect(firstResponse?.status).toBe(401);
    expect(lastResponse).toBeDefined();
    expect(lastResponse?.status).toBe(429);
    expect(await lastResponse?.text()).toBe("Too Many Requests");
  });

  it("does not rate limit valid signed webhook bursts from the same source", async () => {
    const harness = await startWebhookServer({
      onMessage: vi.fn(),
      path: "/nextcloud-auth-rate-limit-valid",
    });
    const { body, headers } = createSignedCreateMessageRequest();

    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests; attempt += 1) {
      lastResponse = await fetch(harness.webhookUrl, {
        body,
        headers,
        method: "POST",
      });
    }

    expect(lastResponse).toBeDefined();
    expect(lastResponse?.status).toBe(200);
  });
});
