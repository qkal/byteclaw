import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerBedrockMantlePlugin } from "./register.sync.runtime.js";

export default definePluginEntry({
  description: "Bundled Amazon Bedrock Mantle (OpenAI-compatible) provider plugin",
  id: "amazon-bedrock-mantle",
  name: "Amazon Bedrock Mantle Provider",
  register(api) {
    registerBedrockMantlePlugin(api);
  },
});
