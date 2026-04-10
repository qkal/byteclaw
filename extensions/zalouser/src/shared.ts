import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  type ResolvedZalouserAccount,
  checkZcaAuthenticated,
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { buildChannelConfigSchema, formatAllowFromLowercase } from "./channel-api.js";
import { ZalouserConfigSchema } from "./config-schema.js";
import { zalouserDoctor } from "./doctor.js";

export const zalouserMeta = {
  aliases: ["zlu"],
  blurb: "Zalo personal account via QR code login.",
  docsLabel: "zalouser",
  docsPath: "/channels/zalouser",
  id: "zalouser",
  label: "Zalo Personal",
  order: 85,
  quickstartAllowFrom: false,
  selectionLabel: "Zalo (Personal Account)",
} satisfies ChannelPlugin<ResolvedZalouserAccount>["meta"];

const zalouserConfigAdapter = createScopedChannelConfigAdapter<ResolvedZalouserAccount>({
  clearBaseFields: [
    "profile",
    "name",
    "dmPolicy",
    "allowFrom",
    "historyLimit",
    "groupAllowFrom",
    "groupPolicy",
    "groups",
    "messagePrefix",
  ],
  defaultAccountId: resolveDefaultZalouserAccountId,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalouser|zlu):/i }),
  listAccountIds: listZalouserAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveZalouserAccountSync),
  resolveAllowFrom: (account) => account.config.allowFrom,
  sectionKey: "zalouser",
});

export function createZalouserPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedZalouserAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedZalouserAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedZalouserAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "doctor"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
> {
  return {
    capabilities: {
      blockStreaming: true,
      chatTypes: ["direct", "group"],
      media: true,
      nativeCommands: false,
      polls: false,
      reactions: true,
      threads: false,
    },
    config: {
      ...zalouserConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
        }),
      isConfigured: async (account) => await checkZcaAuthenticated(account.profile),
    },
    configSchema: buildChannelConfigSchema(ZalouserConfigSchema),
    doctor: zalouserDoctor,
    id: "zalouser",
    meta: zalouserMeta,
    reload: { configPrefixes: ["channels.zalouser"] },
    setup: params.setup,
    setupWizard: params.setupWizard,
  };
}
