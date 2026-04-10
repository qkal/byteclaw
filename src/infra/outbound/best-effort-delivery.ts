import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export interface ExternalBestEffortDeliveryTarget {
  deliver: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
}

export function resolveExternalBestEffortDeliveryTarget(params: {
  channel?: string | null;
  to?: string | null;
  accountId?: string | null;
  threadId?: string | number | null;
}): ExternalBestEffortDeliveryTarget {
  const normalizedChannel = normalizeMessageChannel(params.channel);
  const channel =
    normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
      ? normalizedChannel
      : undefined;
  const to = normalizeOptionalString(params.to);
  const deliver = Boolean(channel && to);
  return {
    accountId: deliver ? normalizeOptionalString(params.accountId) : undefined,
    channel: deliver ? channel : undefined,
    deliver,
    threadId:
      deliver && params.threadId != null && params.threadId !== ""
        ? String(params.threadId)
        : undefined,
    to: deliver ? to : undefined,
  };
}

export function shouldDowngradeDeliveryToSessionOnly(params: {
  wantsDelivery: boolean;
  bestEffortDeliver: boolean;
  resolvedChannel: string;
}): boolean {
  return (
    params.wantsDelivery &&
    params.bestEffortDeliver &&
    params.resolvedChannel === INTERNAL_MESSAGE_CHANNEL
  );
}
