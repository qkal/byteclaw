// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// Not drag setup-only surfaces into lightweight channel plugin loads.
export { discordPlugin } from "./src/channel.js";
