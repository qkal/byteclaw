import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMatrixCliMetadata } from "./src/cli-metadata.js";

export { registerMatrixCliMetadata } from "./src/cli-metadata.js";

export default definePluginEntry({
  description: "Matrix channel plugin (matrix-js-sdk)",
  id: "matrix",
  name: "Matrix",
  register: registerMatrixCliMetadata,
});
