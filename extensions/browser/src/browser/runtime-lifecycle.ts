import type { Server } from "node:http";
import { isPwAiLoaded } from "./pw-ai-state.js";
import type { BrowserServerState } from "./server-context.js";
import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.js";

export async function createBrowserRuntimeState(params: {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  const state: BrowserServerState = {
    port: params.port,
    profiles: new Map(),
    resolved: params.resolved,
    server: params.server ?? null,
  };

  await ensureExtensionRelayForProfiles({
    onWarn: params.onWarn,
    resolved: params.resolved,
  });

  return state;
}

export async function stopBrowserRuntime(params: {
  current: BrowserServerState | null;
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<void> {
  if (!params.current) {
    return;
  }

  await stopKnownBrowserProfiles({
    getState: params.getState,
    onWarn: params.onWarn,
  });

  if (params.closeServer && params.current.server) {
    await new Promise<void>((resolve) => {
      params.current?.server?.close(() => resolve());
    });
  }

  params.clearState();

  if (!isPwAiLoaded()) {
    return;
  }
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // Ignore
  }
}
