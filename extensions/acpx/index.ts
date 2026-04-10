import { createAcpxRuntimeService } from "./register.runtime.js";
import { type OpenClawPluginApi, tryDispatchAcpReplyHook } from "./runtime-api.js";
import { createAcpxPluginConfigSchema } from "./src/config-schema.js";

const plugin = {
  configSchema: () => createAcpxPluginConfigSchema(),
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  id: "acpx",
  name: "ACPX Runtime",
  register(api: OpenClawPluginApi) {
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
    api.on("reply_dispatch", tryDispatchAcpReplyHook);
  },
};

export default plugin;
