import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateElevenLabsLegacyTalkConfig } from "./config-compat.js";

export default definePluginEntry({
  description: "Lightweight ElevenLabs setup hooks",
  id: "elevenlabs",
  name: "ElevenLabs Setup",
  register(api) {
    api.registerConfigMigration((config) => migrateElevenLabsLegacyTalkConfig(config));
  },
});
