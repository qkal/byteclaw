import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import {
  type OpenClawConfig,
  type ResolvedGoogleChatAccount,
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "./channel.deps.runtime.js";
import type { GoogleChatRuntimeEnv } from "./monitor-types.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

export async function startGoogleChatGatewayAccount(ctx: {
  account: ResolvedGoogleChatAccount;
  cfg: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  abortSignal: AbortSignal;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const { account } = ctx;
  const statusSink = createAccountStatusSink({
    accountId: account.accountId,
    setStatus: ctx.setStatus,
  });
  ctx.log?.info?.(`[${account.accountId}] starting Google Chat webhook`);
  const { resolveGoogleChatWebhookPath, startGoogleChatMonitor } =
    await loadGoogleChatChannelRuntime();
  statusSink({
    audience: account.config.audience,
    audienceType: account.config.audienceType,
    lastStartAt: Date.now(),
    running: true,
    webhookPath: resolveGoogleChatWebhookPath({ account }),
  });
  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    onStop: async () => {
      statusSink({
        lastStopAt: Date.now(),
        running: false,
      });
    },
    start: async () =>
      await startGoogleChatMonitor({
        abortSignal: ctx.abortSignal,
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        statusSink,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
      }),
    stop: async (unregister) => {
      unregister?.();
    },
  });
}
