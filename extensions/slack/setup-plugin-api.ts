// Keep bundled setup entry imports narrow so setup loads do not pull the
// Broader Slack channel plugin surface.
export { slackSetupPlugin } from "./src/channel.setup.js";
