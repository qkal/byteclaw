// Keep bundled channel bootstrap loads narrow so lightweight channel entry
// Loads do not import setup-only surfaces.
export { whatsappPlugin } from "./src/channel.js";
