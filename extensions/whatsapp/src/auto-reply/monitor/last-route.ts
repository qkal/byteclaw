import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { formatError } from "../../session.js";
import { resolveStorePath, updateLastRoute } from "../config.runtime.js";

type LoadConfigFn = typeof import("../config.runtime.js").loadConfig;

export function trackBackgroundTask(
  backgroundTasks: Set<Promise<unknown>>,
  task: Promise<unknown>,
) {
  backgroundTasks.add(task);
  void task.finally(() => {
    backgroundTasks.delete(task);
  });
}

export function updateLastRouteInBackground(params: {
  cfg: ReturnType<LoadConfigFn>;
  backgroundTasks: Set<Promise<unknown>>;
  storeAgentId: string;
  sessionKey: string;
  channel: "whatsapp";
  to: string;
  accountId?: string;
  ctx?: MsgContext;
  warn: (obj: unknown, msg: string) => void;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.storeAgentId,
  });
  const task = updateLastRoute({
    ctx: params.ctx,
    deliveryContext: {
      accountId: params.accountId,
      channel: params.channel,
      to: params.to,
    },
    sessionKey: params.sessionKey,
    storePath,
  }).catch((error) => {
    params.warn(
      {
        error: formatError(error),
        sessionKey: params.sessionKey,
        storePath,
        to: params.to,
      },
      "failed updating last route",
    );
  });
  trackBackgroundTask(params.backgroundTasks, task);
}

export function awaitBackgroundTasks(backgroundTasks: Set<Promise<unknown>>) {
  if (backgroundTasks.size === 0) {
    return Promise.resolve();
  }
  return Promise.allSettled(backgroundTasks).then(() => {
    backgroundTasks.clear();
  });
}
