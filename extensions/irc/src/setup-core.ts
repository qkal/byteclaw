import type { ChannelSetupAdapter, ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { DmPolicy } from "openclaw/plugin-sdk/config-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  createSetupInputPresenceValidator,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicySetter,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import type { CoreConfig, IrcAccountConfig, IrcNickServConfig } from "./types.js";

const channel = "irc" as const;
const setIrcTopLevelDmPolicy = createTopLevelChannelDmPolicySetter({
  channel,
});
const setIrcTopLevelAllowFrom = createTopLevelChannelAllowFromSetter({
  channel,
});

type IrcSetupInput = ChannelSetupInput & {
  host?: string;
  port?: number | string;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  channels?: string[];
  password?: string;
};

export function parsePort(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
    return fallback;
  }
  return parsed;
}

export function updateIrcAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<IrcAccountConfig>,
): CoreConfig {
  return patchScopedAccountConfig({
    accountId,
    cfg,
    channelKey: channel,
    ensureAccountEnabled: false,
    ensureChannelEnabled: false,
    patch,
  }) as CoreConfig;
}

export function setIrcDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  return setIrcTopLevelDmPolicy(cfg, dmPolicy) as CoreConfig;
}

export function setIrcAllowFrom(cfg: CoreConfig, allowFrom: string[]): CoreConfig {
  return setIrcTopLevelAllowFrom(cfg, allowFrom) as CoreConfig;
}

export function setIrcNickServ(
  cfg: CoreConfig,
  accountId: string,
  nickserv?: IrcNickServConfig,
): CoreConfig {
  return updateIrcAccountConfig(cfg, accountId, { nickserv });
}

export function setIrcGroupAccess(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
  entries: string[],
  normalizeGroupEntry: (raw: string) => string | null,
): CoreConfig {
  if (policy !== "allowlist") {
    return updateIrcAccountConfig(cfg, accountId, { enabled: true, groupPolicy: policy });
  }
  const normalizedEntries = [
    ...new Set(entries.map((entry) => normalizeGroupEntry(entry)).filter(Boolean)),
  ];
  const groups = Object.fromEntries(normalizedEntries.map((entry) => [entry, {}]));
  return updateIrcAccountConfig(cfg, accountId, {
    enabled: true,
    groupPolicy: "allowlist",
    groups,
  });
}

export const ircSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as IrcSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      accountId,
      cfg,
      channelKey: channel,
      name: setupInput.name,
    });
    const portInput =
      typeof setupInput.port === "number" ? String(setupInput.port) : String(setupInput.port ?? "");
    const patch: Partial<IrcAccountConfig> = {
      channels: setupInput.channels,
      enabled: true,
      host: setupInput.host?.trim(),
      nick: setupInput.nick?.trim(),
      password: setupInput.password?.trim(),
      port: portInput ? parsePort(portInput, setupInput.tls === false ? 6667 : 6697) : undefined,
      realname: setupInput.realname?.trim(),
      tls: setupInput.tls,
      username: setupInput.username?.trim(),
    };
    return patchScopedAccountConfig({
      accountId,
      cfg: namedConfig,
      channelKey: channel,
      patch,
    }) as CoreConfig;
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      accountId,
      cfg,
      channelKey: channel,
      name,
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  validateInput: createSetupInputPresenceValidator({
    whenNotUseEnv: [
      { message: "IRC requires host.", someOf: ["host"] },
      { message: "IRC requires nick.", someOf: ["nick"] },
    ],
  }),
};
