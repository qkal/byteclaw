import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { GetReplyOptions } from "../auto-reply/types.js";
import { clearConfigCache } from "../config/config.js";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  getReplyFromConfig,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { interval: 2, timeout: 250 } as const;
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let harness: GatewayHarness;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
});

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      id,
      method,
      params,
      type: "req",
    }),
  );
};

async function withGatewayChatHarness(
  run: (ctx: { ws: GatewaySocket; createSessionDir: () => Promise<string> }) => Promise<void>,
) {
  const tempDirs: string[] = [];
  const ws = await harness.openWs();
  const createSessionDir = async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    tempDirs.push(sessionDir);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    return sessionDir;
  };

  try {
    await run({ createSessionDir, ws });
  } finally {
    __setMaxChatHistoryMessagesBytesForTest();
    clearConfigCache();
    testState.sessionStorePath = undefined;
    ws.close();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { force: true, recursive: true })));
  }
}

async function writeMainSessionStore() {
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  clearConfigCache();
}

async function writeMainSessionTranscript(sessionDir: string, lines: string[]) {
  await fs.writeFile(path.join(sessionDir, "sess-main.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function fetchHistoryMessages(
  ws: GatewaySocket,
  params?: {
    limit?: number;
    maxChars?: number;
  },
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
    limit: params?.limit ?? 1000,
    sessionKey: "main",
    ...(typeof params?.maxChars === "number" ? { maxChars: params.maxChars } : {}),
  });
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

async function prepareMainHistoryHarness(params: {
  ws: GatewaySocket;
  createSessionDir: () => Promise<string>;
  historyMaxBytes?: number;
}) {
  if (params.historyMaxBytes !== undefined) {
    __setMaxChatHistoryMessagesBytesForTest(params.historyMaxBytes);
  }
  await connectOk(params.ws);
  const sessionDir = await params.createSessionDir();
  await writeMainSessionStore();
  return sessionDir;
}

describe("gateway server chat", () => {
  test("chat.history backfills claude-cli sessions from Claude project files", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const originalHome = process.env.HOME;
      const homeDir = path.join(sessionDir, "home");
      const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      await fs.mkdir(claudeProjectsDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
        [
          JSON.stringify({
            content: "[Thu 2026-03-26 16:29 GMT] hi",
            operation: "enqueue",
            sessionId: cliSessionId,
            timestamp: "2026-03-26T16:29:54.722Z",
            type: "queue-operation",
          }),
          JSON.stringify({
            message: {
              content:
                'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
              role: "user",
            },
            timestamp: "2026-03-26T16:29:54.800Z",
            type: "user",
            uuid: "user-1",
          }),
          JSON.stringify({
            message: {
              content: [{ text: "hello from Claude", type: "text" }],
              model: "claude-sonnet-4-6",
              role: "assistant",
            },
            timestamp: "2026-03-26T16:29:55.500Z",
            type: "assistant",
            uuid: "assistant-1",
          }),
        ].join("\n"),
        "utf8",
      );
      process.env.HOME = homeDir;
      try {
        await writeSessionStore({
          entries: {
            main: {
              cliSessionBindings: {
                "claude-cli": {
                  sessionId: cliSessionId,
                },
              },
              model: "claude-sonnet-4-6",
              modelProvider: "claude-cli",
              sessionId: "sess-main",
              updatedAt: Date.now(),
            },
          },
        });

        const messages = await fetchHistoryMessages(ws);
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
          content: "hi",
          role: "user",
        });
        expect(messages[1]).toMatchObject({
          provider: "claude-cli",
          role: "assistant",
        });
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
      }
    });
  });

  test("smoke: caps history payload and preserves routing metadata", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        createSessionDir,
        historyMaxBytes,
        ws,
      });

      const bigText = "x".repeat(2000);
      const historyLines: string[] = [];
      for (let i = 0; i < 45; i += 1) {
        historyLines.push(
          JSON.stringify({
            message: {
              content: [{ text: `${i}:${bigText}`, type: "text" }],
              role: "user",
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, historyLines);
      const messages = await fetchHistoryMessages(ws);
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(45);

      await writeSessionStore({
        entries: {
          main: {
            lastChannel: "whatsapp",
            lastTo: "+1555",
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        idempotencyKey: "idem-route",
        message: "hello",
        sessionKey: "main",
      });
      expect(sendRes.ok).toBe(true);

      const { sessionStorePath } = testState;
      if (!sessionStorePath) {
        throw new Error("expected session store path");
      }
      const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    });
  });

  test("chat.send does not force-disable block streaming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();
      testState.agentConfig = { blockStreamingDefault: "on" };
      try {
        let capturedOpts: GetReplyOptions | undefined;
        mockGetReplyFromConfigOnce(async (_ctx, opts) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          idempotencyKey: "idem-block-streaming",
          message: "hello",
          sessionKey: "main",
        });
        expect(sendRes.ok).toBe(true);

        await vi.waitFor(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.disableBlockStreaming).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
      }
    });
  });

  test("chat.history hard-caps single oversized nested payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        createSessionDir,
        historyMaxBytes,
        ws,
      });

      const hugeNestedText = "n".repeat(120_000);
      const oversizedLine = JSON.stringify({
        message: {
          content: [
            {
              output: {
                nested: {
                  payload: hugeNestedText,
                },
              },
              toolUseId: "tool-1",
              type: "tool_result",
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      });
      await writeMainSessionTranscript(sessionDir, [oversizedLine]);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(1);

      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history keeps recent small messages when latest message is oversized", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        createSessionDir,
        historyMaxBytes,
        ws,
      });

      const baseText = "s".repeat(1200);
      const lines: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              content: [{ text: `small-${i}:${baseText}`, type: "text" }],
              role: "user",
              timestamp: Date.now() + i,
            },
          }),
        );
      }

      const hugeNestedText = "z".repeat(120_000);
      lines.push(
        JSON.stringify({
          message: {
            content: [
              {
                output: {
                  nested: {
                    payload: hugeNestedText,
                  },
                },
                toolUseId: "tool-1",
                type: "tool_result",
              },
            ],
            role: "assistant",
            timestamp: Date.now() + 1000,
          },
        }),
      );

      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");

      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeGreaterThan(1);
      expect(serialized).toContain("small-29:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history preserves usage and cost metadata for assistant messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            content: [{ text: "hello", type: "text" }],
            cost: { total: 0.0123 },
            details: { debug: true },
            role: "assistant",
            timestamp: Date.now(),
            usage: { input: 12, output: 5, totalTokens: 17 },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        cost: { total: 0.0123 },
        role: "assistant",
        usage: { input: 12, output: 5, totalTokens: 17 },
      });
      expect(messages[0]).not.toHaveProperty("details");
    });
  });

  test("chat.history strips inline directives from displayed message text", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const lines = [
        JSON.stringify({
          message: {
            content: [
              { text: "Hello [[reply_to_current]] world [[audio_as_voice]]", type: "text" },
            ],
            role: "assistant",
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            content: "A [[reply_to:abc-123]] B",
            role: "assistant",
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            text: "[[ reply_to : 456 ]] C",
            timestamp: Date.now() + 2,
          },
        }),
        JSON.stringify({
          message: {
            content: [{ text: "  keep padded  ", type: "text" }],
            role: "assistant",
            timestamp: Date.now() + 3,
          },
        }),
      ];
      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(4);

      const serialized = JSON.stringify(messages);
      expect(serialized.includes("[[reply_to")).toBe(false);
      expect(serialized.includes("[[audio_as_voice]]")).toBe(false);

      const first = messages[0] as { content?: { text?: string }[] };
      const second = messages[1] as { content?: string };
      const third = messages[2] as { text?: string };
      const fourth = messages[3] as { content?: { text?: string }[] };

      expect(first.content?.[0]?.text?.replace(/\s+/g, " ").trim()).toBe("Hello world");
      expect(second.content?.replace(/\s+/g, " ").trim()).toBe("A B");
      expect(third.text?.replace(/\s+/g, " ").trim()).toBe("C");
      expect(fourth.content?.[0]?.text).toBe("  keep padded  ");
    });
  });

  test("chat.history applies gateway.webchat.chatHistoryMaxChars from config", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        gateway: {
          webchat: {
            chatHistoryMaxChars: 5,
          },
        },
      });
      const sessionDir = await prepareMainHistoryHarness({ createSessionDir, ws });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            content: [{ text: "abcdefghij", type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(JSON.stringify(messages)).toContain(String.raw`abcde\n...(truncated)...`);
    });
  });

  test("chat.history prefers RPC maxChars over config", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        gateway: {
          webchat: {
            chatHistoryMaxChars: 3,
          },
        },
      });
      const sessionDir = await prepareMainHistoryHarness({ createSessionDir, ws });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            content: [{ text: "abcdefghij", type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 7 });
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain(String.raw`abcdefg\n...(truncated)...`);
      expect(serialized).not.toContain(String.raw`abc\n...(truncated)...`);
    });
  });

  test("chat.history rejects invalid RPC maxChars values", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ createSessionDir, ws });

      const zeroRes = await rpcReq(ws, "chat.history", {
        maxChars: 0,
        sessionKey: "main",
      });
      expect(zeroRes.ok).toBe(false);
      expect((zeroRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );

      const tooLargeRes = await rpcReq(ws, "chat.history", {
        maxChars: 500_001,
        sessionKey: "main",
      });
      expect(tooLargeRes.ok).toBe(false);
      expect((tooLargeRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );
    });
  });

  test("chat.history still drops assistant NO_REPLY entries before truncation", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ createSessionDir, ws });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            content: [{ text: "NO_REPLY", type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 3 });
      expect(messages).toEqual([]);
    });
  });

  test("smoke: supports abort and idempotent completion", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      let aborted = false;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return undefined;
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 2000);
      sendReq(ws, "send-abort-1", "chat.send", {
        idempotencyKey: "idem-abort-1",
        message: "hello",
        sessionKey: "main",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await vi.waitFor(() => {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);

      const inFlight = await rpcReq<{ status?: string }>(ws, "chat.send", {
        idempotencyKey: "idem-abort-1",
        message: "hello",
        sessionKey: "main",
      });
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{ aborted?: boolean }>(ws, "chat.abort", {
        runId: "idem-abort-1",
        sessionKey: "main",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      await vi.waitFor(() => {
        expect(aborted).toBe(true);
      }, FAST_WAIT_OPTS);

      spy.mockClear();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        idempotencyKey: "idem-complete-1",
        message: "hello",
        sessionKey: "main",
      });
      expect(completeRes.ok).toBe(true);

      await vi.waitFor(async () => {
        const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
          idempotencyKey: "idem-complete-1",
          message: "hello",
          sessionKey: "main",
        });
        expect(again.ok).toBe(true);
        expect(again.payload?.status).toBe("ok");
      }, FAST_WAIT_OPTS);
    });
  });
});
