import { createHash } from "node:crypto";
import { once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { WEBHOOK_RATE_LIMIT_DEFAULTS } from "openclaw/plugin-sdk/webhook-ingress";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const handlerSpy = vi.hoisted(() => vi.fn((..._args: unknown[]): unknown => undefined));
const setWebhookSpy = vi.hoisted(() => vi.fn());
const deleteWebhookSpy = vi.hoisted(() => vi.fn(async () => true));
const initSpy = vi.hoisted(() => vi.fn(async () => undefined));
const stopSpy = vi.hoisted(() => vi.fn());
const webhookCallbackSpy = vi.hoisted(() => vi.fn(() => handlerSpy));
const createTelegramBotSpy = vi.hoisted(() =>
  vi.fn(() => ({
    api: { deleteWebhook: deleteWebhookSpy, setWebhook: setWebhookSpy },
    init: initSpy,
    stop: stopSpy,
  })),
);

const WEBHOOK_POST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 8000;
const TELEGRAM_TOKEN = "tok";
const TELEGRAM_SECRET = "secret";
const TELEGRAM_WEBHOOK_PATH = "/hook";
const WEBHOOK_TEST_YIELD_MS = 0;
const WEBHOOK_DRAIN_GUARD_MS = 5;
const TELEGRAM_WEBHOOK_RATE_LIMIT_BURST = WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests + 10;

function collectResponseBody(
  res: IncomingMessage,
  onDone: (payload: { statusCode: number; body: string }) => void,
): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  res.on("end", () => {
    onDone({
      body: Buffer.concat(chunks).toString("utf8"),
      statusCode: res.statusCode ?? 0,
    });
  });
}

function createSingleSettlement<T>(params: {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  clear: () => void;
}) {
  let settled = false;
  return {
    isSettled() {
      return settled;
    },
    reject(error: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      params.clear();
      params.reject(error);
    },
    resolve(value: T) {
      if (settled) {
        return;
      }
      settled = true;
      params.clear();
      params.resolve(value);
    },
  };
}

vi.mock("grammy", async () => {
  const actual = await vi.importActual<typeof import("grammy")>("grammy");
  return {
    ...actual,
    API_CONSTANTS: actual.API_CONSTANTS ?? {
      ALL_UPDATE_TYPES: ["message"],
      DEFAULT_UPDATE_TYPES: ["message"],
    },
    GrammyError:
      actual.GrammyError ??
      class GrammyError extends Error {
        description = "";
      },
    InputFile:
      actual.InputFile ??
      class InputFile {
        constructor(public readonly path: string) {}
      },
    webhookCallback: webhookCallbackSpy,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotSpy,
}));

let startTelegramWebhook: typeof import("./webhook.js").startTelegramWebhook;

function resetTelegramWebhookMocks(): void {
  handlerSpy.mockReset();
  handlerSpy.mockImplementation((..._args: unknown[]): unknown => undefined);

  setWebhookSpy.mockReset();
  deleteWebhookSpy.mockReset();
  deleteWebhookSpy.mockImplementation(async () => true);
  initSpy.mockReset();
  initSpy.mockImplementation(async () => undefined);
  stopSpy.mockReset();
  webhookCallbackSpy.mockReset();
  webhookCallbackSpy.mockImplementation(() => handlerSpy);
  createTelegramBotSpy.mockReset();
  createTelegramBotSpy.mockImplementation(() => ({
    api: { deleteWebhook: deleteWebhookSpy, setWebhook: setWebhookSpy },
    init: initSpy,
    stop: stopSpy,
  }));
}

beforeAll(async () => {
  ({ startTelegramWebhook } = await import("./webhook.js"));
});

beforeEach(() => {
  resetTelegramWebhookMocks();
});

async function fetchWithTimeout(
  input: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postWebhookJson(params: {
  url: string;
  payload: string;
  secret?: string;
  timeoutMs?: number;
}): Promise<Response> {
  return await fetchWithTimeout(
    params.url,
    {
      body: params.payload,
      headers: {
        "content-type": "application/json",
        ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
      },
      method: "POST",
    },
    params.timeoutMs ?? 5000,
  );
}

async function postWebhookHeadersOnly(params: {
  port: number;
  path: string;
  declaredLength: number;
  secret?: string;
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const settle = createSingleSettlement({
      clear: () => clearTimeout(timeout),
      reject,
      resolve,
    });

    const req = request(
      {
        headers: {
          "content-length": String(params.declaredLength),
          "content-type": "application/json",
          ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
        },
        hostname: "127.0.0.1",
        method: "POST",
        path: params.path,
        port: params.port,
      },
      (res) => {
        collectResponseBody(res, (payload) => {
          settle.resolve(payload);
          req.destroy();
        });
      },
    );

    const timeout = setTimeout(() => {
      req.destroy(
        new Error(`webhook header-only post timed out after ${params.timeoutMs ?? 5000}ms`),
      );
      settle.reject(new Error("timed out waiting for webhook response"));
    }, params.timeoutMs ?? 5000);

    req.on("error", (error) => {
      if (settle.isSettled() && (error as NodeJS.ErrnoException).code === "ECONNRESET") {
        return;
      }
      settle.reject(error);
    });

    req.flushHeaders();
  });
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

async function postWebhookPayloadWithChunkPlan(params: {
  port: number;
  path: string;
  payload: string;
  secret: string;
  mode: "single" | "random-chunked";
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string }> {
  const payloadBuffer = Buffer.from(params.payload, "utf8");
  return await new Promise((resolve, reject) => {
    let bytesQueued = 0;
    let chunksQueued = 0;
    let phase: "writing" | "awaiting-response" = "writing";
    const settle = createSingleSettlement({
      clear: () => clearTimeout(timeout),
      reject,
      resolve,
    });

    const req = request(
      {
        headers: {
          "content-length": String(payloadBuffer.length),
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": params.secret,
        },
        hostname: "127.0.0.1",
        method: "POST",
        path: params.path,
        port: params.port,
      },
      (res) => {
        collectResponseBody(res, settle.resolve);
      },
    );

    const timeout = setTimeout(() => {
      settle.reject(
        new Error(
          `webhook post timed out after ${params.timeoutMs ?? 15_000}ms (phase=${phase}, bytesQueued=${bytesQueued}, chunksQueued=${chunksQueued}, totalBytes=${payloadBuffer.length})`,
        ),
      );
      req.destroy();
    }, params.timeoutMs ?? 15_000);

    req.on("error", (error) => {
      settle.reject(error);
    });

    const writeAll = async () => {
      if (params.mode === "single") {
        req.end(payloadBuffer);
        return;
      }

      const rng = createDeterministicRng(26_156);
      let offset = 0;
      while (offset < payloadBuffer.length) {
        const remaining = payloadBuffer.length - offset;
        const nextSize = Math.max(1, Math.min(remaining, 1 + Math.floor(rng() * 8192)));
        const chunk = payloadBuffer.subarray(offset, offset + nextSize);
        const canContinue = req.write(chunk);
        offset += nextSize;
        bytesQueued = offset;
        chunksQueued += 1;
        if (chunksQueued % 10 === 0) {
          await sleep(WEBHOOK_TEST_YIELD_MS);
        }
        if (!canContinue) {
          // Windows CI occasionally stalls on waiting for drain indefinitely.
          // Bound the wait, then continue queuing this small (~1MB) payload.
          await Promise.race([once(req, "drain"), sleep(WEBHOOK_DRAIN_GUARD_MS)]);
        }
      }
      phase = "awaiting-response";
      req.end();
    };

    void writeAll().catch((error) => {
      settle.reject(error);
    });
  });
}

function createNearLimitTelegramPayload(): { payload: string; sizeBytes: number } {
  const maxBytes = 1024 * 1024;
  const targetBytes = maxBytes - 4096;
  const shell = { message: { text: "" }, update_id: 77_777 };
  const shellSize = Buffer.byteLength(JSON.stringify(shell), "utf8");
  const textLength = Math.max(1, targetBytes - shellSize);
  const pattern = "the quick brown fox jumps over the lazy dog ";
  const repeats = Math.ceil(textLength / pattern.length);
  const text = pattern.repeat(repeats).slice(0, textLength);
  const payload = JSON.stringify({
    message: { text },
    update_id: 77_777,
  });
  return { payload, sizeBytes: Buffer.byteLength(payload, "utf8") };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type StartWebhookOptions = Omit<
  Parameters<typeof startTelegramWebhook>[0],
  "token" | "port" | "abortSignal"
>;

type StartedWebhook = Awaited<ReturnType<typeof startTelegramWebhook>>;

function getServerPort(server: StartedWebhook["server"]): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no addr");
  }
  return address.port;
}

function webhookUrl(port: number, webhookPath: string): string {
  return `http://127.0.0.1:${port}${webhookPath}`;
}

async function withStartedWebhook<T>(
  options: StartWebhookOptions,
  run: (ctx: { server: StartedWebhook["server"]; port: number }) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const started = await startTelegramWebhook({
    abortSignal: abort.signal,
    port: 0,
    token: TELEGRAM_TOKEN,
    ...options,
  });
  try {
    return await run({ port: getServerPort(started.server), server: started.server });
  } finally {
    abort.abort();
  }
}

function expectSingleNearLimitUpdate(params: {
  seenUpdates: { update_id: number; message: { text: string } }[];
  expected: { update_id: number; message: { text: string } };
}) {
  expect(params.seenUpdates).toHaveLength(1);
  expect(params.seenUpdates[0]?.update_id).toBe(params.expected.update_id);
  expect(params.seenUpdates[0]?.message.text.length).toBe(params.expected.message.text.length);
  expect(sha256(params.seenUpdates[0]?.message.text ?? "")).toBe(
    sha256(params.expected.message.text),
  );
}

async function runNearLimitPayloadTest(mode: "single" | "random-chunked"): Promise<void> {
  const seenUpdates: { update_id: number; message: { text: string } }[] = [];
  webhookCallbackSpy.mockImplementationOnce(
    () =>
      vi.fn(
        (
          update: unknown,
          reply: (json: string) => Promise<void>,
          _secretHeader: string | undefined,
          _unauthorized: () => Promise<void>,
        ) => {
          seenUpdates.push(update as { update_id: number; message: { text: string } });
          void reply("ok");
        },
      ) as unknown as typeof handlerSpy,
  );

  const { payload, sizeBytes } = createNearLimitTelegramPayload();
  expect(sizeBytes).toBeLessThan(1024 * 1024);
  expect(sizeBytes).toBeGreaterThan(256 * 1024);
  const expected = JSON.parse(payload) as { update_id: number; message: { text: string } };

  await withStartedWebhook(
    {
      path: TELEGRAM_WEBHOOK_PATH,
      secret: TELEGRAM_SECRET,
    },
    async ({ port }) => {
      const response = await postWebhookPayloadWithChunkPlan({
        mode,
        path: TELEGRAM_WEBHOOK_PATH,
        payload,
        port,
        secret: TELEGRAM_SECRET,
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });

      expect(response.statusCode).toBe(200);
      expectSingleNearLimitUpdate({ expected, seenUpdates });
    },
  );
}

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    initSpy.mockClear();
    createTelegramBotSpy.mockClear();
    webhookCallbackSpy.mockClear();
    const runtimeLog = vi.fn();
    const cfg = { bindings: [] };
    await withStartedWebhook(
      {
        accountId: "opie",
        config: cfg,
        runtime: { error: vi.fn(), exit: vi.fn(), log: runtimeLog },
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        expect(createTelegramBotSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "opie",
            config: expect.objectContaining({ bindings: [] }),
          }),
        );
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(setWebhookSpy).toHaveBeenCalled();
        expect(webhookCallbackSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            api: expect.objectContaining({
              setWebhook: expect.any(Function),
            }),
          }),
          "callback",
          {
            onTimeout: "return",
            secretToken: TELEGRAM_SECRET,
            timeoutMilliseconds: 10_000,
          },
        );
        expect(runtimeLog).toHaveBeenCalledWith(
          expect.stringContaining("webhook local listener on http://127.0.0.1:"),
        );
        expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("/telegram-webhook"));
        expect(runtimeLog).toHaveBeenCalledWith(
          expect.stringContaining("webhook advertised to telegram on http://"),
        );
      },
    );
  });

  it("registers webhook with certificate when webhookCertPath is provided", async () => {
    setWebhookSpy.mockClear();
    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
        webhookCertPath: "/path/to/cert.pem",
      },
      async () => {
        expect(setWebhookSpy).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            certificate: expect.anything(),
          }),
        );
        const certificate = setWebhookSpy.mock.calls[0]?.[1]?.certificate as
          | { path?: string; fileData?: string; filename?: string }
          | undefined;
        expect(certificate).toBeDefined();
        if (certificate && "path" in certificate && typeof certificate.path === "string") {
          expect(certificate.path).toBe("/path/to/cert.pem");
        } else {
          expect(certificate).toEqual(
            expect.objectContaining({
              fileData: "/path/to/cert.pem",
              filename: "cert.pem",
            }),
          );
        }
      },
    );
  });

  it("invokes webhook handler on matching path", async () => {
    handlerSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const cfg = { bindings: [] };
    await withStartedWebhook(
      {
        accountId: "opie",
        config: cfg,
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        expect(createTelegramBotSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "opie",
            config: expect.objectContaining({ bindings: [] }),
          }),
        );
        const payload = JSON.stringify({ message: { text: "hello" }, update_id: 1 });
        const response = await postWebhookJson({
          payload,
          secret: TELEGRAM_SECRET,
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
        });
        expect(response.status).toBe(200);
        expect(handlerSpy).toHaveBeenCalledWith(
          JSON.parse(payload),
          expect.any(Function),
          TELEGRAM_SECRET,
          expect.any(Function),
        );
      },
    );
  });

  it("rejects unauthenticated requests before reading the request body", async () => {
    handlerSpy.mockClear();
    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        const response = await postWebhookHeadersOnly({
          declaredLength: 1024 * 1024,
          path: TELEGRAM_WEBHOOK_PATH,
          port,
          secret: "wrong-secret",
        });

        expect(response.statusCode).toBe(401);
        expect(response.body).toBe("unauthorized");
        expect(handlerSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("rate limits repeated invalid secret guesses before authentication succeeds", async () => {
    handlerSpy.mockClear();
    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        let saw429 = false;

        for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
          const response = await postWebhookJson({
            payload: JSON.stringify({ message: { text: `guess ${i}` }, update_id: i }),
            secret: `wrong-secret-${String(i).padStart(3, "0")}`,
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          });

          if (response.status === 429) {
            saw429 = true;
            expect(await response.text()).toBe("Too Many Requests");
            break;
          }

          expect(response.status).toBe(401);
          expect(await response.text()).toBe("unauthorized");
        }

        expect(saw429).toBe(true);

        const validResponse = await postWebhookJson({
          payload: JSON.stringify({ message: { text: "hello" }, update_id: 999 }),
          secret: TELEGRAM_SECRET,
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
        });
        expect(validResponse.status).toBe(429);
        expect(await validResponse.text()).toBe("Too Many Requests");
        expect(handlerSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the forwarded client ip when trusted proxies are configured", async () => {
    handlerSpy.mockClear();
    await withStartedWebhook(
      {
        config: {
          gateway: {
            trustedProxies: ["127.0.0.1"],
          },
        },
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
          const response = await fetchWithTimeout(
            webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            {
              body: JSON.stringify({ message: { text: `guess ${i}` }, update_id: i }),
              headers: {
                "content-type": "application/json",
                "x-forwarded-for": "198.51.100.10",
                "x-telegram-bot-api-secret-token": `wrong-secret-${String(i).padStart(3, "0")}`,
              },
              method: "POST",
            },
            5000,
          );
          if (response.status === 429) {
            break;
          }
          expect(response.status).toBe(401);
        }

        const isolatedClient = await fetchWithTimeout(
          webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          {
            body: JSON.stringify({ message: { text: "hello" }, update_id: 201 }),
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": "203.0.113.20",
              "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
            },
            method: "POST",
          },
          5000,
        );

        expect(isolatedClient.status).toBe(200);
        expect(handlerSpy).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("keeps rate-limit state isolated per webhook listener", async () => {
    handlerSpy.mockClear();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = await startTelegramWebhook({
      abortSignal: firstAbort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
      port: 0,
      secret: TELEGRAM_SECRET,
      token: TELEGRAM_TOKEN,
    });
    const second = await startTelegramWebhook({
      abortSignal: secondAbort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
      port: 0,
      secret: TELEGRAM_SECRET,
      token: TELEGRAM_TOKEN,
    });

    try {
      const firstPort = getServerPort(first.server);
      const secondPort = getServerPort(second.server);

      for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
        const response = await postWebhookJson({
          payload: JSON.stringify({ message: { text: `guess ${i}` }, update_id: i }),
          secret: `wrong-secret-${String(i).padStart(3, "0")}`,
          url: webhookUrl(firstPort, TELEGRAM_WEBHOOK_PATH),
        });
        if (response.status === 429) {
          break;
        }
      }

      const secondResponse = await postWebhookJson({
        payload: JSON.stringify({ message: { text: "hello" }, update_id: 301 }),
        secret: TELEGRAM_SECRET,
        url: webhookUrl(secondPort, TELEGRAM_WEBHOOK_PATH),
      });

      expect(secondResponse.status).toBe(200);
      expect(handlerSpy).toHaveBeenCalledTimes(1);
    } finally {
      firstAbort.abort();
      secondAbort.abort();
    }
  });

  it("rejects startup when webhook secret is missing", async () => {
    await expect(
      startTelegramWebhook({
        token: "tok",
      }),
    ).rejects.toThrow(/requires a non-empty secret token/i);
  });

  it("registers webhook using the bound listening port when port is 0", async () => {
    setWebhookSpy.mockClear();
    const runtimeLog = vi.fn();
    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { error: vi.fn(), exit: vi.fn(), log: runtimeLog },
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        expect(port).toBeGreaterThan(0);
        expect(setWebhookSpy).toHaveBeenCalledTimes(1);
        expect(setWebhookSpy).toHaveBeenCalledWith(
          webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          expect.objectContaining({
            secret_token: TELEGRAM_SECRET,
          }),
        );
        expect(runtimeLog).toHaveBeenCalledWith(
          `webhook local listener on ${webhookUrl(port, TELEGRAM_WEBHOOK_PATH)}`,
        );
      },
    );
  });

  it("keeps webhook payload readable when callback delays body read", async () => {
    handlerSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const [update, reply] = args as [unknown, (json: string) => Promise<void>];
      await sleep(WEBHOOK_TEST_YIELD_MS);
      await reply(JSON.stringify(update));
    });

    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        const payload = JSON.stringify({ message: { text: "hello" }, update_id: 1 });
        const res = await postWebhookJson({
          payload,
          secret: TELEGRAM_SECRET,
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
        });
        expect(res.status).toBe(200);
        const responseBody = await res.text();
        expect(JSON.parse(responseBody)).toEqual(JSON.parse(payload));
      },
    );
  });

  it("keeps webhook payload readable across multiple delayed reads", async () => {
    const seenPayloads: string[] = [];
    const delayedHandler = async (...args: unknown[]) => {
      const [update, reply] = args as [unknown, (json: string) => Promise<void>];
      await sleep(WEBHOOK_TEST_YIELD_MS);
      seenPayloads.push(JSON.stringify(update));
      await reply("ok");
    };
    handlerSpy.mockImplementationOnce(delayedHandler).mockImplementationOnce(delayedHandler);

    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        const payloads = [
          JSON.stringify({ message: { text: "first" }, update_id: 1 }),
          JSON.stringify({ message: { text: "second" }, update_id: 2 }),
        ];

        for (const payload of payloads) {
          const res = await postWebhookJson({
            payload,
            secret: TELEGRAM_SECRET,
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          });
          expect(res.status).toBe(200);
        }

        expect(seenPayloads.map((x) => JSON.parse(x))).toEqual(payloads.map((x) => JSON.parse(x)));
      },
    );
  });

  it("processes a second request after first-request delayed-init data loss", async () => {
    const seenUpdates: unknown[] = [];
    webhookCallbackSpy.mockImplementationOnce(
      () =>
        vi.fn(
          (
            update: unknown,
            reply: (json: string) => Promise<void>,
            _secretHeader: string | undefined,
            _unauthorized: () => Promise<void>,
          ) => {
            seenUpdates.push(update);
            void (async () => {
              await sleep(WEBHOOK_TEST_YIELD_MS);
              await reply("ok");
            })();
          },
        ) as unknown as typeof handlerSpy,
    );

    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        const firstPayload = JSON.stringify({ message: { text: "first" }, update_id: 100 });
        const secondPayload = JSON.stringify({ message: { text: "second" }, update_id: 101 });
        const firstResponse = await postWebhookPayloadWithChunkPlan({
          mode: "single",
          path: TELEGRAM_WEBHOOK_PATH,
          payload: firstPayload,
          port,
          secret: TELEGRAM_SECRET,
          timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
        });
        const secondResponse = await postWebhookPayloadWithChunkPlan({
          mode: "single",
          path: TELEGRAM_WEBHOOK_PATH,
          payload: secondPayload,
          port,
          secret: TELEGRAM_SECRET,
          timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
        });

        expect(firstResponse.statusCode).toBe(200);
        expect(secondResponse.statusCode).toBe(200);
        expect(seenUpdates).toEqual([JSON.parse(firstPayload), JSON.parse(secondPayload)]);
      },
    );
  });

  it("handles near-limit payload with random chunk writes and event-loop yields", async () => {
    await runNearLimitPayloadTest("random-chunked");
  });

  it("handles near-limit payload written in a single request write", async () => {
    await runNearLimitPayloadTest("single");
  });

  it("rejects payloads larger than 1MB before invoking webhook handler", async () => {
    handlerSpy.mockClear();
    await withStartedWebhook(
      {
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
      },
      async ({ port }) => {
        const responseOrError = await new Promise<
          | { kind: "response"; statusCode: number; body: string }
          | { kind: "error"; code: string | undefined }
        >((resolve) => {
          const req = request(
            {
              headers: {
                "content-length": String(1024 * 1024 + 2048),
                "content-type": "application/json",
                "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
              },
              hostname: "127.0.0.1",
              method: "POST",
              path: TELEGRAM_WEBHOOK_PATH,
              port,
            },
            (res) => {
              collectResponseBody(res, (payload) => {
                resolve({ kind: "response", ...payload });
              });
            },
          );
          req.on("error", (error: NodeJS.ErrnoException) => {
            resolve({ code: error.code, kind: "error" });
          });
          req.end("{}");
        });

        if (responseOrError.kind === "response") {
          expect(responseOrError.statusCode).toBe(413);
          expect(responseOrError.body).toBe("Payload too large");
        } else {
          expect(responseOrError.code).toBeOneOf(["ECONNRESET", "EPIPE"]);
        }
        expect(handlerSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("de-registers webhook when shutting down", async () => {
    deleteWebhookSpy.mockClear();
    const abort = new AbortController();
    await startTelegramWebhook({
      abortSignal: abort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
      port: 0,
      secret: TELEGRAM_SECRET,
      token: TELEGRAM_TOKEN,
    });

    abort.abort();
    expect(deleteWebhookSpy).toHaveBeenCalledTimes(1);
    expect(deleteWebhookSpy).toHaveBeenCalledWith({ drop_pending_updates: false });
  });
});
