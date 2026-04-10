import "./test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { type Mock, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { WebInboundMessage, WebListenerCloseReason } from "./inbound.js";
import {
  resetBaileysMocks as _resetBaileysMocks,
  resetLoadConfigMock as _resetLoadConfigMock,
} from "./test-helpers.js";

export { resetBaileysMocks, resetLoadConfigMock, setLoadConfigMock } from "./test-helpers.js";

// Avoid exporting inferred vitest mock types (TS2742 under pnpm + d.ts emit).
type AnyExport = any;
interface MockWebListener {
  close: () => Promise<void>;
  onClose: Promise<WebListenerCloseReason>;
  signalClose: () => void;
  sendMessage: () => Promise<{ messageId: string }>;
  sendPoll: () => Promise<{ messageId: string }>;
  sendReaction: () => Promise<void>;
  sendComposingTo: () => Promise<void>;
}
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
interface WebAutoReplyRuntime {
  log: UnknownMock;
  error: UnknownMock;
  exit: UnknownMock;
}
interface WebAutoReplyMonitorHarness {
  runtime: WebAutoReplyRuntime;
  controller: AbortController;
  run: Promise<unknown>;
}

export const TEST_NET_IP = "203.0.113.10";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  appendCronStyleCurrentTimeLine: (text: string) => text,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  resolveIdentityNamePrefix: (cfg: { messages?: { responsePrefix?: string } }, _agentId: string) =>
    cfg.messages?.responsePrefix,
  resolveMessagePrefix: (cfg: { messages?: { messagePrefix?: string } }) =>
    cfg.messages?.messagePrefix,
  runEmbeddedPiAgent: vi.fn(),
}));

export async function rmDirWithRetries(
  dir: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 10;
  const delayMs = opts?.delayMs ?? 5;
  // Some tests can leave async session-store writes in-flight; recursive deletion can race and throw ENOTEMPTY.
  // Let Node handle retries (faster than re-walking the tree in JS on each retry).
  try {
    await fs.rm(dir, {
      force: true,
      maxRetries: attempts,
      recursive: true,
      retryDelay: delayMs,
    });
    return;
  } catch {
    // Fall back for older Node implementations (or unexpected retry behavior).
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fs.rm(dir, { force: true, recursive: true });
        return;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : null;
        if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }

    await fs.rm(dir, { force: true, recursive: true });
  }
}

let previousHome: string | undefined;
let tempHome: string | undefined;
let tempHomeRoot: string | undefined;
let tempHomeId = 0;

export function installWebAutoReplyTestHomeHooks() {
  beforeAll(async () => {
    tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-web-home-suite-"));
  });

  beforeEach(async () => {
    resetInboundDedupe();
    previousHome = process.env.HOME;
    tempHome = path.join(tempHomeRoot ?? os.tmpdir(), `case-${++tempHomeId}`);
    await fs.mkdir(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    tempHome = undefined;
  });

  afterAll(async () => {
    if (tempHomeRoot) {
      await rmDirWithRetries(tempHomeRoot);
      tempHomeRoot = undefined;
    }
    tempHomeId = 0;
  });
}

export async function makeSessionStore(
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  const cleanup = async () => {
    await rmDirWithRetries(dir);
  };
  return {
    cleanup,
    storePath,
  };
}

export function installWebAutoReplyUnitTestHooks(opts?: { pinDns?: boolean }) {
  let resolvePinnedHostnameSpy: { mockRestore: () => unknown } | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetBaileysMocks();
    _resetLoadConfigMock();
    if (opts?.pinDns) {
      const ssrf = await import("../../../src/infra/net/ssrf.js");
      resolvePinnedHostnameSpy = vi
        .spyOn(ssrf, "resolvePinnedHostname")
        .mockImplementation(async (hostname) => {
          // SSRF guard pins DNS; stub resolution to avoid live lookups in unit tests.
          const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
          const addresses = [TEST_NET_IP];
          return {
            addresses,
            hostname: normalized,
            lookup: ssrf.createPinnedLookup({ addresses, hostname: normalized }),
          };
        });
    }
  });

  afterEach(() => {
    resolvePinnedHostnameSpy?.mockRestore();
    resolvePinnedHostnameSpy = undefined;
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });
}

export function createWebListenerFactoryCapture(): AnyExport {
  let capturedOnMessage: ((msg: WebInboundMessage) => Promise<void>) | undefined;
  const listenerFactory = async (opts: {
    onMessage: (msg: WebInboundMessage) => Promise<void>;
  }) => {
    capturedOnMessage = opts.onMessage;
    return { close: vi.fn() };
  };

  return {
    getOnMessage: () => capturedOnMessage,
    listenerFactory,
  };
}

export function createMockWebListener(): MockWebListener {
  return {
    close: vi.fn(async () => undefined),
    onClose: new Promise<WebListenerCloseReason>(() => {}),
    sendComposingTo: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => undefined),
    signalClose: vi.fn(),
  };
}

export function createScriptedWebListenerFactory(): AnyExport {
  const onMessages: ((msg: WebInboundMessage) => Promise<void>)[] = [];
  const closeResolvers: ((reason: unknown) => void)[] = [];
  const listeners: MockWebListener[] = [];

  const listenerFactory = vi.fn(
    async (opts: { onMessage: (msg: WebInboundMessage) => Promise<void> }) => {
      onMessages.push(opts.onMessage);
      let resolveClose: (reason: unknown) => void = () => {};
      const onClose = new Promise<WebListenerCloseReason>((res) => {
        resolveClose = res as (reason: unknown) => void;
        closeResolvers.push(resolveClose);
      });
      const listener: MockWebListener = {
        ...createMockWebListener(),
        onClose,
        signalClose: vi.fn((reason?: unknown) => resolveClose(reason)),
      };
      listeners.push(listener);
      return listener;
    },
  );

  return {
    getListenerCount: () => listenerFactory.mock.calls.length,
    getOnMessage: (index = onMessages.length - 1) => onMessages[index],
    listenerFactory,
    listeners,
    resolveClose: (index: number, reason?: unknown) => closeResolvers[index]?.(reason),
  };
}

export function createWebInboundDeliverySpies(): AnyExport {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    sendComposing: vi.fn(),
    sendMedia: vi.fn(),
  };
}

export function createWebAutoReplyRuntime(): WebAutoReplyRuntime {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

export function startWebAutoReplyMonitor(params: {
  monitorWebChannelFn: (...args: unknown[]) => Promise<unknown>;
  listenerFactory: unknown;
  sleep: UnknownMock | AsyncUnknownMock;
  signal?: AbortSignal;
  heartbeatSeconds?: number;
  messageTimeoutMs?: number;
  watchdogCheckMs?: number;
  reconnect?: { initialMs: number; maxMs: number; maxAttempts: number; factor: number };
}): WebAutoReplyMonitorHarness {
  const runtime = createWebAutoReplyRuntime();
  const controller = new AbortController();
  const run = params.monitorWebChannelFn(
    false,
    params.listenerFactory as never,
    true,
    async () => ({ text: "ok" }),
    runtime as never,
    params.signal ?? controller.signal,
    {
      heartbeatSeconds: params.heartbeatSeconds ?? 1,
      messageTimeoutMs: params.messageTimeoutMs,
      reconnect: params.reconnect ?? { factor: 1.1, initialMs: 10, maxAttempts: 3, maxMs: 10 },
      sleep: params.sleep,
      watchdogCheckMs: params.watchdogCheckMs,
    },
  );

  return { controller, run, runtime };
}

export async function sendWebGroupInboundMessage(params: {
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  body: string;
  id: string;
  senderE164: string;
  senderName: string;
  mentionedJids?: string[];
  selfE164?: string;
  selfJid?: string;
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  conversationId?: string;
  accountId?: string;
}) {
  const conversationId = params.conversationId ?? "123@g.us";
  const accountId = params.accountId ?? "default";
  await params.onMessage({
    accountId,
    body: params.body,
    chatId: conversationId,
    chatType: "group",
    conversationId,
    from: conversationId,
    id: params.id,
    mentionedJids: params.mentionedJids,
    reply: params.spies.reply,
    selfE164: params.selfE164,
    selfJid: params.selfJid,
    sendComposing: params.spies.sendComposing,
    sendMedia: params.spies.sendMedia,
    senderE164: params.senderE164,
    senderName: params.senderName,
    to: "+2",
  } as WebInboundMessage);
}

export async function sendWebDirectInboundMessage(params: {
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  body: string;
  id: string;
  from: string;
  to: string;
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  accountId?: string;
  timestamp?: number;
}) {
  const accountId = params.accountId ?? "default";
  await params.onMessage({
    accountId,
    body: params.body,
    chatId: `direct:${params.from}`,
    chatType: "direct",
    conversationId: params.from,
    from: params.from,
    id: params.id,
    reply: params.spies.reply,
    sendComposing: params.spies.sendComposing,
    sendMedia: params.spies.sendMedia,
    timestamp: params.timestamp ?? Date.now(),
    to: params.to,
  } as WebInboundMessage);
}
