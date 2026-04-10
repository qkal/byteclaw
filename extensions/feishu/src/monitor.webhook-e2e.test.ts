import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuRuntimeMockModule } from "./monitor.test-mocks.js";
import { withRunningWebhookMonitor } from "./monitor.webhook.test-helpers.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  };
});

vi.mock("./runtime.js", () => createFeishuRuntimeMockModule());

import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";

function signFeishuPayload(params: {
  encryptKey: string;
  rawBody: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = params.timestamp ?? "1711111111";
  const nonce = params.nonce ?? "nonce-test";
  const signature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + params.encryptKey + params.rawBody)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-nonce": nonce,
    "x-lark-request-timestamp": timestamp,
    "x-lark-signature": signature,
  };
}

function encryptFeishuPayload(encryptKey: string, payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

async function postSignedPayload(url: string, payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  return await fetch(url, {
    body: rawBody,
    headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
    method: "POST",
  });
}

afterEach(() => {
  stopFeishuMonitor();
});

describe("Feishu webhook signed-request e2e", () => {
  it("rejects invalid signatures with 401 instead of empty 200", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "invalid-signature",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-invalid-signature",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { challenge: "challenge-token", type: "url_verification" };
        const rawBody = JSON.stringify(payload);
        const response = await fetch(url, {
          body: rawBody,
          headers: {
            ...signFeishuPayload({ encryptKey: "wrong_key", rawBody }),
          },
          method: "POST",
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("rejects missing signature headers with 401", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "missing-signature",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-missing-signature",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          body: JSON.stringify({ challenge: "challenge-token", type: "url_verification" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("rejects malformed short signatures with 401", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "short-signature",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-short-signature",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { challenge: "challenge-token", type: "url_verification" };
        const headers = signFeishuPayload({
          encryptKey: "encrypt_key",
          rawBody: JSON.stringify(payload),
        });
        headers["x-lark-signature"] = headers["x-lark-signature"].slice(0, 12);

        const response = await fetch(url, {
          body: JSON.stringify(payload),
          headers,
          method: "POST",
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("returns 401 for unsigned invalid json before parsing", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "invalid-json",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-invalid-json",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          body: "{not-json",
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("returns 400 for signed invalid json after signature validation", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-invalid-json",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-signed-invalid-json",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const rawBody = "{not-json";
        const response = await fetch(url, {
          body: rawBody,
          headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
          method: "POST",
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Invalid JSON");
      },
    );
  });

  it("accepts signed plaintext url_verification challenges end-to-end", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-challenge",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-signed-challenge",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { challenge: "challenge-token", type: "url_verification" };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ challenge: "challenge-token" });
      },
    );
  });

  it("accepts signed non-challenge events and reaches the dispatcher", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-dispatch",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-signed-dispatch",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          event: {},
          header: { event_type: "unknown.event" },
          schema: "2.0",
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("no unknown.event event handle");
      },
    );
  });

  it("accepts signed encrypted url_verification challenges end-to-end", async () => {
    probeFeishuMock.mockResolvedValue({ botOpenId: "bot_open_id", ok: true });

    await withRunningWebhookMonitor(
      {
        accountId: "encrypted-challenge",
        encryptKey: "encrypt_key",
        path: "/hook-e2e-encrypted-challenge",
        verificationToken: "verify_token",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          encrypt: encryptFeishuPayload("encrypt_key", {
            challenge: "encrypted-challenge-token",
            type: "url_verification",
          }),
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          challenge: "encrypted-challenge-token",
        });
      },
    );
  });
});
