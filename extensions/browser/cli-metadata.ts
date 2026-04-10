import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  description: "Default browser tool plugin",
  id: "browser",
  name: "Browser",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerBrowserCli } = await import("./runtime-api.js");
        registerBrowserCli(program);
      },
      { commands: ["browser"] },
    );
  },
});
