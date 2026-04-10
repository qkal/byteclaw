import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acp-runtime.js").tryDispatchAcpReplyHook;

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as {
    sessionKey?: string;
    ctx?: {
      SessionKey?: string;
      CommandTargetSessionKey?: string;
      AcpDispatchTailAfterReset?: boolean;
    };
  };
  if (event.ctx?.AcpDispatchTailAfterReset) {
    return true;
  }
  return [event.sessionKey, event.ctx?.SessionKey, event.ctx?.CommandTargetSessionKey].some(
    (value) => {
      const key = value?.trim();
      return Boolean(key && (key.includes("acp:") || key.includes(":acp") || key.includes("-acp")));
    },
  );
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

function createMockAcpSessionManager() {
  return {
    getObservabilitySnapshot: () => ({
      errorsByCode: {},
      runtimeCache: { activeSessions: 0, evictedTotal: 0, idleTtlMs: 0 },
      turns: {
        active: 0,
        averageLatencyMs: 0,
        completed: 0,
        failed: 0,
        maxLatencyMs: 0,
        queueDepth: 0,
      },
    }),
    resolveSession: (params: { cfg: OpenClawConfig; sessionKey: string }) => {
      const entry = acpMocks.readAcpSessionEntry({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
      }) as { acp?: Record<string, unknown> } | null;
      if (entry?.acp) {
        return {
          kind: "ready" as const,
          meta: entry.acp,
          sessionKey: params.sessionKey,
        };
      }
      return { kind: "none" as const, sessionKey: params.sessionKey };
    },
    runTurn: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        text?: string;
        attachments?: unknown[];
        mode: string;
        requestId: string;
        signal?: AbortSignal;
        onEvent: (event: Record<string, unknown>) => Promise<void>;
      }) => {
        const entry = acpMocks.readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        }) as {
          acp?: { agent?: string; mode?: string };
        } | null;
        const runtimeBackend = acpMocks.requireAcpRuntimeBackend() as {
          runtime?: AcpRuntime;
        };
        if (!runtimeBackend.runtime) {
          throw new Error("ACP runtime backend not mocked");
        }
        const handle = await runtimeBackend.runtime.ensureSession({
          agent: entry?.acp?.agent || "codex",
          mode: (entry?.acp?.mode || "persistent") as AcpRuntimeEnsureInput["mode"],
          sessionKey: params.sessionKey,
        });
        const stream = runtimeBackend.runtime.runTurn({
          attachments: params.attachments as AcpRuntimeTurnInput["attachments"],
          handle,
          mode: params.mode as AcpRuntimeTurnInput["mode"],
          requestId: params.requestId,
          signal: params.signal,
          text: params.text ?? "",
        });
        for await (const event of stream) {
          await params.onEvent(event);
        }
      },
    ),
  };
}

describe("dispatchReplyFromConfig ACP abort", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acp-runtime.js"));
  });

  beforeEach(() => {
    setDiscordTestRegistry();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(createMockAcpSessionManager());
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runBeforeDispatch.mockReset();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown, ctx: unknown) => {
      if (!shouldUseAcpReplyDispatchHook(event)) {
        return undefined;
      }
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    hookMocks.runner.runInboundClaim.mockReset();
    hookMocks.runner.runInboundClaim.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset();
    hookMocks.runner.runInboundClaimForPlugin.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset();
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset();
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
    sessionStoreMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.getAcpRuntimeBackend.mockReset();
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    resetPluginTtsAndThreadMocks();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    setNoAbort();
  });

  it("aborts ACP dispatch promptly when the caller abort signal fires", async () => {
    let releaseTurn: (() => void) | undefined;
    const releasePromise = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const runtime = {
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      ensureSession: vi.fn(
        async (input: { sessionKey: string; mode: string; agent: string }) =>
          ({
            backend: "acpx",
            runtimeSessionName: `${input.sessionKey}:${input.mode}`,
            sessionKey: input.sessionKey,
          }) as AcpRuntimeHandle,
      ),
      runTurn: vi.fn(async function* runTurn(params: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (params.signal?.aborted) {
            resolve();
            return;
          }
          const onAbort = () => resolve();
          params.signal?.addEventListener("abort", onAbort, { once: true });
          void releasePromise.then(resolve);
        });
        yield { type: "done" } as AcpRuntimeEvent;
      }),
    } satisfies AcpRuntime;
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:1",
        state: "idle",
      },
      cfg: {},
      entry: {},
      sessionKey: "agent:codex-acp:session-1",
      storePath: "/tmp/mock-sessions.json",
      storeSessionKey: "agent:codex-acp:session-1",
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "write a test",
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      cfg: {
        acp: {
          dispatch: { enabled: true },
          enabled: true,
        },
      } as OpenClawConfig,
      ctx,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
    });

    await vi.waitFor(() => {
      expect(runtime.runTurn).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    const outcome = await Promise.race([
      dispatchPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    releaseTurn?.();
    await dispatchPromise;

    expect(outcome).toBe("settled");
  });
});
