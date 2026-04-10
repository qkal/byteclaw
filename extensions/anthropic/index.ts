import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAnthropicPlugin } from "./register.runtime.js";

export default definePluginEntry({
  description: "Bundled Anthropic provider plugin",
  id: "anthropic",
  name: "Anthropic Provider",
  register(api) {
    return registerAnthropicPlugin(api);
  },
});
