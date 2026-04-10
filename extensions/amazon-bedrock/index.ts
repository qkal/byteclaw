import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAmazonBedrockPlugin } from "./register.sync.runtime.js";

export default definePluginEntry({
  description: "Bundled Amazon Bedrock provider policy plugin",
  id: "amazon-bedrock",
  name: "Amazon Bedrock Provider",
  register(api) {
    registerAmazonBedrockPlugin(api);
  },
});
