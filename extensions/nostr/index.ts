import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { PluginRuntime, ResolvedNostrAccount } from "./api.js";

function createNostrProfileHttpHandler() {
  return loadBundledEntryExportSync<
    (params: Record<string, unknown>) => (ctx: unknown) => Promise<void> | void
  >(import.meta.url, {
    exportName: "createNostrProfileHttpHandler",
    specifier: "./api.js",
  });
}

function getNostrRuntime() {
  return loadBundledEntryExportSync<() => PluginRuntime>(import.meta.url, {
    exportName: "getNostrRuntime",
    specifier: "./api.js",
  })();
}

function resolveNostrAccount(params: { cfg: unknown; accountId: string }) {
  return loadBundledEntryExportSync<
    (params: { cfg: unknown; accountId: string }) => ResolvedNostrAccount
  >(import.meta.url, {
    exportName: "resolveNostrAccount",
    specifier: "./api.js",
  })(params);
}

export default defineBundledChannelEntry({
  description: "Nostr DM channel plugin via NIP-04",
  id: "nostr",
  importMetaUrl: import.meta.url,
  name: "Nostr",
  plugin: {
    exportName: "nostrPlugin",
    specifier: "./api.js",
  },
  registerFull(api) {
    const httpHandler = createNostrProfileHttpHandler()({
      getAccountInfo: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const account = resolveNostrAccount({ cfg, accountId });
        if (!account.configured || !account.publicKey) {
          return null;
        }
        return {
          pubkey: account.publicKey,
          relays: account.relays,
        };
      },
      getConfigProfile: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const account = resolveNostrAccount({ cfg, accountId });
        return account.profile;
      },
      log: api.logger,
      updateConfigProfile: async (accountId: string, profile: unknown) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();

        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;

        await runtime.config.writeConfigFile({
          ...cfg,
          channels: {
            ...channels,
            nostr: {
              ...nostrConfig,
              profile,
            },
          },
        });
      },
    });

    api.registerHttpRoute({
      auth: "gateway",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: httpHandler,
      match: "prefix",
      path: "/api/channels/nostr",
    });
  },
  runtime: {
    exportName: "setNostrRuntime",
    specifier: "./api.js",
  },
});
