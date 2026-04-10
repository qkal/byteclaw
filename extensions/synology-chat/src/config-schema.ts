import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      dangerouslyAllowInheritedWebhookPath: z.boolean().optional(),
      dangerouslyAllowNameMatching: z.boolean().optional(),
    })
    .passthrough(),
);
