import { GoogleChatConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk/googlechat";

export const GoogleChatChannelConfigSchema = buildChannelConfigSchema(GoogleChatConfigSchema);
