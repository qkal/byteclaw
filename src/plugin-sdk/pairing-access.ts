import type { ChannelId } from "../channels/plugins/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

type PairingApi = PluginRuntime["channel"]["pairing"];
type ScopedUpsertInput = Omit<
  Parameters<PairingApi["upsertPairingRequest"]>[0],
  "channel" | "accountId"
>;

/** Scope pairing store operations to one channel/account pair for plugin-facing helpers. */
export function createScopedPairingAccess(params: {
  core: PluginRuntime;
  channel: ChannelId;
  accountId: string;
}) {
  const resolvedAccountId = normalizeAccountId(params.accountId);
  return {
    accountId: resolvedAccountId,
    readAllowFromStore: () =>
      params.core.channel.pairing.readAllowFromStore({
        accountId: resolvedAccountId,
        channel: params.channel,
      }),
    readStoreForDmPolicy: (provider: ChannelId, accountId: string) =>
      params.core.channel.pairing.readAllowFromStore({
        accountId: normalizeAccountId(accountId),
        channel: provider,
      }),
    upsertPairingRequest: (input: ScopedUpsertInput) =>
      params.core.channel.pairing.upsertPairingRequest({
        accountId: resolvedAccountId,
        channel: params.channel,
        ...input,
      }),
  };
}
