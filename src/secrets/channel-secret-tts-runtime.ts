import type {
  ChannelAccountPredicate,
  ChannelAccountSurface,
} from "./channel-secret-basic-runtime.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import { isRecord } from "./shared.js";

export function collectNestedChannelTtsAssignments(params: {
  channelKey: string;
  nestedKey: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topLevelActive: boolean;
  topInactiveReason: string;
  accountActive: ChannelAccountPredicate;
  accountInactiveReason:
    | string
    | ((entry: {
        accountId: string;
        account: Record<string, unknown>;
        enabled: boolean;
      }) => string);
}): void {
  const topLevelNested = params.channel[params.nestedKey];
  if (isRecord(topLevelNested) && isRecord(topLevelNested.tts)) {
    collectTtsApiKeyAssignments({
      active: params.topLevelActive,
      context: params.context,
      defaults: params.defaults,
      inactiveReason: params.topInactiveReason,
      pathPrefix: `channels.${params.channelKey}.${params.nestedKey}.tts`,
      tts: topLevelNested.tts,
    });
  }
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const entry of params.surface.accounts) {
    const nested = entry.account[params.nestedKey];
    if (!isRecord(nested) || !isRecord(nested.tts)) {
      continue;
    }
    collectTtsApiKeyAssignments({
      active: params.accountActive(entry),
      context: params.context,
      defaults: params.defaults,
      inactiveReason:
        typeof params.accountInactiveReason === "function"
          ? params.accountInactiveReason(entry)
          : params.accountInactiveReason,
      pathPrefix: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.nestedKey}.tts`,
      tts: nested.tts,
    });
  }
}
