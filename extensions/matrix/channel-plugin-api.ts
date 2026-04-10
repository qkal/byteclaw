// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// Not pull the broad Matrix API barrel into lightweight plugin loads.
export { matrixPlugin } from "./src/channel.js";
