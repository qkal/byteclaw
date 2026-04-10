import { type PinnedDispatcherPolicy, formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SsrFPolicy } from "../runtime-api.js";
import type { BaseProbeResult } from "../runtime-api.js";
import { isBunRuntime } from "./client/runtime.js";

type MatrixProbeRuntimeDeps = Pick<typeof import("./probe.runtime.js"), "createMatrixClient">;

let matrixProbeRuntimeDepsPromise: Promise<MatrixProbeRuntimeDeps> | undefined;

async function loadMatrixProbeRuntimeDeps(): Promise<MatrixProbeRuntimeDeps> {
  matrixProbeRuntimeDepsPromise ??= import("./probe.runtime.js").then((runtimeModule) => ({
    createMatrixClient: runtimeModule.createMatrixClient,
  }));
  return await matrixProbeRuntimeDepsPromise;
}

export type MatrixProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  userId?: string | null;
};

export async function probeMatrix(params: {
  homeserver: string;
  accessToken: string;
  userId?: string;
  deviceId?: string;
  timeoutMs?: number;
  accountId?: string | null;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<MatrixProbe> {
  const started = Date.now();
  const result: MatrixProbe = {
    elapsedMs: 0,
    error: null,
    ok: false,
    status: null,
  };
  if (isBunRuntime()) {
    return {
      ...result,
      elapsedMs: Date.now() - started,
      error: "Matrix probe requires Node (bun runtime not supported)",
    };
  }
  if (!params.homeserver?.trim()) {
    return {
      ...result,
      elapsedMs: Date.now() - started,
      error: "missing homeserver",
    };
  }
  if (!params.accessToken?.trim()) {
    return {
      ...result,
      elapsedMs: Date.now() - started,
      error: "missing access token",
    };
  }
  try {
    const { createMatrixClient } = await loadMatrixProbeRuntimeDeps();
    const inputUserId = normalizeOptionalString(params.userId);
    const client = await createMatrixClient({
      accessToken: params.accessToken,
      accountId: params.accountId,
      allowPrivateNetwork: params.allowPrivateNetwork,
      deviceId: params.deviceId,
      dispatcherPolicy: params.dispatcherPolicy,
      homeserver: params.homeserver,
      localTimeoutMs: params.timeoutMs,
      persistStorage: false,
      ssrfPolicy: params.ssrfPolicy,
      userId: inputUserId,
    });
    // The client wrapper resolves user ID via whoami when needed.
    const userId = await client.getUserId();
    result.ok = true;
    result.userId = userId ?? null;

    result.elapsedMs = Date.now() - started;
    return result;
  } catch (error) {
    return {
      ...result,
      elapsedMs: Date.now() - started,
      error: formatErrorMessage(error),
      status:
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: number }).statusCode)
          : result.status,
    };
  }
}
