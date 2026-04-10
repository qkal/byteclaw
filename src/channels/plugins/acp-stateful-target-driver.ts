import {
  ensureConfiguredAcpBindingReady,
  ensureConfiguredAcpBindingSession,
} from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "../../acp/persistent-bindings.resolve.js";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { performGatewaySessionReset } from "./acp-stateful-target-reset.runtime.js";
import type {
  ConfiguredBindingResolution,
  StatefulBindingTargetDescriptor,
} from "./binding-types.js";
import type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetSessionResult,
} from "./stateful-target-drivers.js";

function toAcpStatefulBindingTargetDescriptor(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): StatefulBindingTargetDescriptor | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const meta = readAcpSessionEntry({
    ...params,
    sessionKey,
  })?.acp;
  const metaAgentId = meta?.agent?.trim();
  if (metaAgentId) {
    return {
      agentId: metaAgentId,
      driverId: "acp",
      kind: "stateful",
      sessionKey,
    };
  }
  const spec = resolveConfiguredAcpBindingSpecBySessionKey({
    ...params,
    sessionKey,
  });
  if (!spec) {
    if (!isAcpSessionKey(sessionKey)) {
      return null;
    }
    // Bound ACP sessions can intentionally clear their ACP metadata after a
    // Reset. The native /reset path still needs to recognize the ACP session
    // Key as resettable while that metadata is absent.
    return {
      agentId: resolveAgentIdFromSessionKey(sessionKey),
      driverId: "acp",
      kind: "stateful",
      sessionKey,
    };
  }
  return {
    agentId: spec.agentId,
    driverId: "acp",
    kind: "stateful",
    sessionKey,
    ...(spec.label ? { label: spec.label } : {}),
  };
}

async function ensureAcpTargetReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<StatefulBindingTargetReadyResult> {
  const configuredBinding = resolveConfiguredAcpBindingSpecFromRecord(
    params.bindingResolution.record,
  );
  if (!configuredBinding) {
    return {
      error: "Configured ACP binding unavailable",
      ok: false,
    };
  }
  return await ensureConfiguredAcpBindingReady({
    cfg: params.cfg,
    configuredBinding: {
      record: params.bindingResolution.record,
      spec: configuredBinding,
    },
  });
}

async function ensureAcpTargetSession(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<StatefulBindingTargetSessionResult> {
  const spec = resolveConfiguredAcpBindingSpecFromRecord(params.bindingResolution.record);
  if (!spec) {
    return {
      error: "Configured ACP binding unavailable",
      ok: false,
      sessionKey: params.bindingResolution.statefulTarget.sessionKey,
    };
  }
  return await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec,
  });
}

async function resetAcpTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  bindingTarget: StatefulBindingTargetDescriptor;
  reason: "new" | "reset";
  commandSource?: string;
}): Promise<StatefulBindingTargetResetResult> {
  const result = await performGatewaySessionReset({
    commandSource: params.commandSource ?? "stateful-target:acp-reset-in-place",
    key: params.sessionKey,
    reason: params.reason,
  });
  if (result.ok) {
    return { ok: true };
  }
  return {
    error: result.error.message,
    ok: false,
  };
}

export const acpStatefulBindingTargetDriver: StatefulBindingTargetDriver = {
  ensureReady: ensureAcpTargetReady,
  ensureSession: ensureAcpTargetSession,
  id: "acp",
  resetInPlace: resetAcpTargetInPlace,
  resolveTargetBySessionKey: toAcpStatefulBindingTargetDescriptor,
};
