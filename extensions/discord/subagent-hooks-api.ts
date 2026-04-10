// Subagent hooks live behind a dedicated barrel so the bundled entry can lazy
// Load only the handlers it needs.
export {
  handleDiscordSubagentDeliveryTarget,
  handleDiscordSubagentEnded,
  handleDiscordSubagentSpawning,
} from "./src/subagent-hooks.js";
