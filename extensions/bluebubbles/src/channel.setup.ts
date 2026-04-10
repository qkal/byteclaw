import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import {
  bluebubblesCapabilities,
  bluebubblesConfigAdapter,
  bluebubblesConfigSchema,
  bluebubblesMeta,
  bluebubblesReload,
  describeBlueBubblesAccount,
} from "./channel-shared.js";
import { blueBubblesSetupAdapter } from "./setup-core.js";
import { blueBubblesSetupWizard } from "./setup-surface.js";

export const bluebubblesSetupPlugin: ChannelPlugin<ResolvedBlueBubblesAccount> = {
  capabilities: bluebubblesCapabilities,
  config: {
    ...bluebubblesConfigAdapter,
    describeAccount: (account) => describeBlueBubblesAccount(account),
    isConfigured: (account) => account.configured,
  },
  configSchema: bluebubblesConfigSchema,
  id: "bluebubbles",
  meta: {
    ...bluebubblesMeta,
    aliases: [...bluebubblesMeta.aliases],
    preferOver: [...bluebubblesMeta.preferOver],
  },
  reload: bluebubblesReload,
  setup: blueBubblesSetupAdapter,
  setupWizard: blueBubblesSetupWizard,
};
