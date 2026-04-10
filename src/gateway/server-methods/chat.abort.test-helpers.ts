import { vi } from "vitest";
import type { Mock } from "vitest";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

export function createActiveRun(
  sessionKey: string,
  params: {
    sessionId?: string;
    owner?: { connId?: string; deviceId?: string };
  } = {},
) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    expiresAtMs: now + 30_000,
    ownerConnId: params.owner?.connId,
    ownerDeviceId: params.owner?.deviceId,
    sessionId: params.sessionId ?? `${sessionKey}-session`,
    sessionKey,
    startedAtMs: now,
  };
}

export type ChatAbortTestContext = Record<string, unknown> & {
  chatAbortControllers: Map<string, ReturnType<typeof createActiveRun>>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  chatAbortedRuns: Map<string, number>;
  removeChatRun: (...args: unknown[]) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (...args: unknown[]) => void;
  nodeSendToSession: (...args: unknown[]) => void;
  logGateway: { warn: (...args: unknown[]) => void };
};

export type ChatAbortRespondMock = Mock<RespondFn>;

export function createChatAbortContext(
  overrides: Record<string, unknown> = {},
): ChatAbortTestContext {
  return {
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map<string, number>(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaSentAt: new Map(),
    chatRunBuffers: new Map(),
    logGateway: { warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ clientRunId: run, sessionKey: "main" })),
    ...overrides,
  };
}

export async function invokeChatAbortHandler(params: {
  handler: GatewayRequestHandler;
  context: ChatAbortTestContext;
  request: { sessionKey: string; runId?: string };
  client?: {
    connId?: string;
    connect?: {
      device?: { id?: string };
      scopes?: string[];
    };
  } | null;
  respond?: ChatAbortRespondMock;
}): Promise<ChatAbortRespondMock> {
  const respond = params.respond ?? vi.fn();
  await params.handler({
    client: (params.client ?? null) as never,
    context: params.context as never,
    isWebchatConnect: () => false,
    params: params.request,
    req: {} as never,
    respond: respond as never,
  });
  return respond;
}
