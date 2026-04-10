// Keep bundled setup entry imports narrow so setup loads do not pull the
// Broader Telegram channel plugin surface.
export { telegramSetupPlugin } from "./src/channel.setup.js";
