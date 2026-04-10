import { type OpenClawPluginApi, definePluginEntry } from "./runtime-api.js";

export default definePluginEntry({
  description: "Plugin-shipped prose skills bundle",
  id: "open-prose",
  name: "OpenProse",
  register(_api: OpenClawPluginApi) {
    // OpenProse is delivered via plugin-shipped skills.
  },
});
