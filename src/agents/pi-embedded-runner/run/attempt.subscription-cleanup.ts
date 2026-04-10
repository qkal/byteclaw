import type { SubscribeEmbeddedPiSessionParams } from "../../pi-embedded-subscribe.types.js";

interface IdleAwareAgent {
  waitForIdle?: (() => Promise<void>) | undefined;
}

interface ToolResultFlushManager {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
}
export function buildEmbeddedSubscriptionParams(
  params: SubscribeEmbeddedPiSessionParams,
): SubscribeEmbeddedPiSessionParams {
  return params;
}

export async function cleanupEmbeddedAttemptResources(params: {
  removeToolResultContextGuard?: () => void;
  flushPendingToolResultsAfterIdle: (params: {
    agent: IdleAwareAgent | null | undefined;
    sessionManager: ToolResultFlushManager | null | undefined;
    timeoutMs?: number;
    clearPendingOnTimeout?: boolean;
  }) => Promise<void>;
  session?: { agent?: unknown; dispose(): void };
  sessionManager: unknown;
  releaseWsSession: (sessionId: string) => void;
  sessionId: string;
  bundleLspRuntime?: { dispose(): Promise<void> | void };
  sessionLock: { release(): Promise<void> | void };
}): Promise<void> {
  try {
    try {
      params.removeToolResultContextGuard?.();
    } catch {
      /* Best-effort */
    }
    try {
      await params.flushPendingToolResultsAfterIdle({
        agent: params.session?.agent as IdleAwareAgent | null | undefined,
        clearPendingOnTimeout: true,
        sessionManager: params.sessionManager as ToolResultFlushManager | null | undefined,
      });
    } catch {
      /* Best-effort */
    }
    try {
      params.session?.dispose();
    } catch {
      /* Best-effort */
    }
    try {
      params.releaseWsSession(params.sessionId);
    } catch {
      /* Best-effort */
    }
    try {
      await params.bundleLspRuntime?.dispose();
    } catch {
      /* Best-effort */
    }
  } finally {
    await params.sessionLock.release();
  }
}
