import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  browserPluginNodeHostCommands,
  browserPluginReload,
  browserSecurityAuditCollectors,
  registerBrowserPlugin,
} from "./plugin-registration.js";

export default definePluginEntry({
  description: "Default browser tool plugin",
  id: "browser",
  name: "Browser",
  nodeHostCommands: browserPluginNodeHostCommands,
  register: registerBrowserPlugin,
  reload: browserPluginReload,
  securityAuditCollectors: [...browserSecurityAuditCollectors],
});
