import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
  listDirectoryEntriesFromSources,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { ChannelPlugin } from "./channel-api.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { resolveMSTeamsCredentials } from "./token.js";

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

export const msteamsDirectoryAdapter: NonNullable<ChannelPlugin["directory"]> =
  createChannelDirectoryAdapter({
    listGroups: async ({ cfg, query, limit }) =>
      listDirectoryEntriesFromSources({
        kind: "group",
        limit,
        normalizeId: (raw) => `conversation:${raw.replace(/^conversation:/i, "").trim()}`,
        query,
        sources: [
          Object.values(cfg.channels?.msteams?.teams ?? {}).flatMap((team) =>
            Object.keys(team.channels ?? {}),
          ),
        ],
      }),
    listPeers: async ({ cfg, query, limit }) =>
      listDirectoryEntriesFromSources({
        kind: "user",
        limit,
        normalizeId: (raw) => {
          const normalized = normalizeMSTeamsMessagingTarget(raw) ?? raw;
          const lowered = normalizeLowercaseStringOrEmpty(normalized);
          if (lowered.startsWith("user:") || lowered.startsWith("conversation:")) {
            return normalized;
          }
          return `user:${normalized}`;
        },
        query,
        sources: [
          cfg.channels?.msteams?.allowFrom ?? [],
          Object.keys(cfg.channels?.msteams?.dms ?? {}),
        ],
      }),
    self: async ({ cfg }) => {
      const creds = resolveMSTeamsCredentials(cfg.channels?.msteams);
      if (!creds) {
        return null;
      }
      return { id: creds.appId, kind: "user" as const, name: creds.appId };
    },
    ...createRuntimeDirectoryLiveAdapter({
      getRuntime: loadMSTeamsChannelRuntime,
      listGroupsLive: (runtime) => runtime.listMSTeamsDirectoryGroupsLive,
      listPeersLive: (runtime) => runtime.listMSTeamsDirectoryPeersLive,
    }),
  });
