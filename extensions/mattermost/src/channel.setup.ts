import type { ChannelPlugin } from "./channel-api.js";
import {
  describeMattermostAccount,
  isMattermostConfigured,
  mattermostConfigAdapter,
  mattermostMeta,
} from "./channel-config-shared.js";
import { MattermostChannelConfigSchema } from "./config-surface.js";
import type { ResolvedMattermostAccount } from "./mattermost/accounts.js";
import { mattermostSetupAdapter } from "./setup-core.js";
import { mattermostSetupWizard } from "./setup-surface.js";

export const mattermostSetupPlugin: ChannelPlugin<ResolvedMattermostAccount> = {
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    media: true,
    nativeCommands: true,
    reactions: true,
    threads: true,
  },
  config: {
    ...mattermostConfigAdapter,
    describeAccount: describeMattermostAccount,
    isConfigured: isMattermostConfigured,
  },
  configSchema: MattermostChannelConfigSchema,
  id: "mattermost",
  meta: {
    ...mattermostMeta,
  },
  reload: { configPrefixes: ["channels.mattermost"] },
  setup: mattermostSetupAdapter,
  setupWizard: mattermostSetupWizard,
};
