// Private runtime barrel for the bundled Zalo extension.
// Keep this barrel thin and free of channel plugin exports so direct runtime
// Imports do not re-enter the full channel/setup surface.
export * from "./src/runtime-api.js";
