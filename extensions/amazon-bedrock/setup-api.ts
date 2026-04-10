import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateAmazonBedrockLegacyConfig } from "./config-api.js";
import { resolveBedrockConfigApiKey } from "./discovery.js";

export default definePluginEntry({
  description: "Lightweight Amazon Bedrock setup hooks",
  id: "amazon-bedrock",
  name: "Amazon Bedrock Setup",
  register(api) {
    api.registerProvider({
      auth: [],
      id: "amazon-bedrock",
      label: "Amazon Bedrock",
      resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env),
    });
    api.registerConfigMigration((config) => migrateAmazonBedrockLegacyConfig(config));
  },
});
