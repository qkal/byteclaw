import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { probeZalo } from "./probe.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import {
  type ChannelPlugin,
  type OpenClawConfig,
  PAIRING_APPROVED_MESSAGE,
} from "./runtime-api.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { sendMessageZalo } from "./send.js";
import type { ResolvedZaloAccount } from "./types.js";

export async function notifyZaloPairingApproval(params: { cfg: OpenClawConfig; id: string }) {
  const { resolveZaloAccount } = await import("./accounts.js");
  const account = resolveZaloAccount({ cfg: params.cfg });
  if (!account.token) {
    throw new Error("Zalo token not configured");
  }
  await sendMessageZalo(params.id, PAIRING_APPROVED_MESSAGE, {
    token: account.token,
  });
}

export async function sendZaloText(
  params: Parameters<typeof sendMessageZalo>[2] & {
    to: string;
    text: string;
  },
) {
  return await sendMessageZalo(params.to, params.text, params);
}

export async function probeZaloAccount(params: {
  account: import("./accounts.js").ResolvedZaloAccount;
  timeoutMs?: number;
}) {
  return await probeZalo(
    params.account.token,
    params.timeoutMs,
    resolveZaloProxyFetch(params.account.config.proxy),
  );
}

export async function startZaloGatewayAccount(
  ctx: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedZaloAccount>["gateway"]>["startAccount"]>
  >[0],
) {
  const { account } = ctx;
  const token = account.token.trim();
  const mode = account.config.webhookUrl ? "webhook" : "polling";
  let zaloBotLabel = "";
  const fetcher = resolveZaloProxyFetch(account.config.proxy);
  try {
    const probe = await probeZalo(token, 2500, fetcher);
    const name = probe.ok ? probe.bot?.name?.trim() : null;
    if (name) {
      zaloBotLabel = ` (${name})`;
    }
    if (!probe.ok) {
      ctx.log?.warn?.(
        `[${account.accountId}] Zalo probe failed before provider start (${String(probe.elapsedMs)}ms): ${probe.error}`,
      );
    }
    ctx.setStatus({
      accountId: account.accountId,
      bot: probe.bot,
    });
  } catch (error) {
    ctx.log?.warn?.(
      `[${account.accountId}] Zalo probe threw before provider start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  ctx.log?.info(`[${account.accountId}] starting provider${zaloBotLabel} mode=${mode}`);
  const { monitorZaloProvider } = await import("./monitor.js");
  return monitorZaloProvider({
    abortSignal: ctx.abortSignal,
    account,
    config: ctx.cfg,
    fetcher,
    runtime: ctx.runtime,
    statusSink,
    token,
    useWebhook: Boolean(account.config.webhookUrl),
    webhookPath: account.config.webhookPath,
    webhookSecret: normalizeSecretInputString(account.config.webhookSecret),
    webhookUrl: account.config.webhookUrl,
  });
}
