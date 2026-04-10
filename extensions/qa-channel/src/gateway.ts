import { pollQaBus } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import type { ChannelGatewayContext } from "./runtime-api.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

export async function startQaGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedQaChannelAccount>,
) {
  const { account } = ctx;
  if (!account.configured) {
    throw new Error(`QA channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    configured: true,
    enabled: account.enabled,
    running: true,
  });
  let cursor = 0;
  try {
    while (!ctx.abortSignal.aborted) {
      const result = await pollQaBus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        cursor,
        signal: ctx.abortSignal,
        timeoutMs: account.pollTimeoutMs,
      });
      ({ cursor } = result);
      for (const event of result.events) {
        if (event.kind !== "inbound-message") {
          continue;
        }
        await handleQaInbound({
          account,
          channelId,
          channelLabel,
          config: ctx.cfg as CoreConfig,
          message: event.message,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: false,
  });
}
