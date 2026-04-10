import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  description: "Voice call channel plugin",
  id: "voice-call",
  name: "Voice Call",
  register(api) {
    api.registerCli(() => {}, { commands: ["voicecall"] });
  },
});
