import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { getAcpSessionManager } from "./manager.js";

export interface AcpSpawnRuntimeCloseHandle {
  runtime: {
    close: (params: {
      handle: { sessionKey: string; backend: string; runtimeSessionName: string };
      reason: string;
    }) => Promise<void>;
  };
  handle: { sessionKey: string; backend: string; runtimeSessionName: string };
}

export async function cleanupFailedAcpSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  shouldDeleteSession: boolean;
  deleteTranscript: boolean;
  runtimeCloseHandle?: AcpSpawnRuntimeCloseHandle;
}): Promise<void> {
  if (params.runtimeCloseHandle) {
    await params.runtimeCloseHandle.runtime
      .close({
        handle: params.runtimeCloseHandle.handle,
        reason: "spawn-failed",
      })
      .catch((error) => {
        logVerbose(
          `acp-spawn: runtime cleanup close failed for ${params.sessionKey}: ${String(error)}`,
        );
      });
  }

  const acpManager = getAcpSessionManager();
  await acpManager
    .closeSession({
      allowBackendUnavailable: true,
      cfg: params.cfg,
      reason: "spawn-failed",
      requireAcpSession: false,
      sessionKey: params.sessionKey,
    })
    .catch((error) => {
      logVerbose(
        `acp-spawn: manager cleanup close failed for ${params.sessionKey}: ${String(error)}`,
      );
    });

  await getSessionBindingService()
    .unbind({
      reason: "spawn-failed",
      targetSessionKey: params.sessionKey,
    })
    .catch((error) => {
      logVerbose(
        `acp-spawn: binding cleanup unbind failed for ${params.sessionKey}: ${String(error)}`,
      );
    });

  if (!params.shouldDeleteSession) {
    return;
  }
  await callGateway({
    method: "sessions.delete",
    params: {
      deleteTranscript: params.deleteTranscript,
      emitLifecycleHooks: false,
      key: params.sessionKey,
    },
    timeoutMs: 10_000,
  }).catch(() => {
    // Best-effort cleanup only.
  });
}
