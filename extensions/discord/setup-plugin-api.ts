// Keep bundled setup entry imports narrow so setup loads do not pull the
// Broader Discord channel plugin surface.
export { discordSetupPlugin } from "./src/channel.setup.js";
