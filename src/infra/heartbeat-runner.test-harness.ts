import { beforeEach } from "vitest";
import {
  heartbeatRunnerSlackPlugin,
  heartbeatRunnerTelegramPlugin,
  heartbeatRunnerWhatsAppPlugin,
} from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

export function installHeartbeatRunnerTestRuntime(params?: { includeSlack?: boolean }): void {
  beforeEach(() => {
    if (params?.includeSlack) {
      setActivePluginRegistry(
        createTestRegistry([
          { plugin: heartbeatRunnerSlackPlugin, pluginId: "slack", source: "test" },
          { plugin: heartbeatRunnerWhatsAppPlugin, pluginId: "whatsapp", source: "test" },
          { plugin: heartbeatRunnerTelegramPlugin, pluginId: "telegram", source: "test" },
        ]),
      );
      return;
    }
    setActivePluginRegistry(
      createTestRegistry([
        { plugin: heartbeatRunnerWhatsAppPlugin, pluginId: "whatsapp", source: "test" },
        { plugin: heartbeatRunnerTelegramPlugin, pluginId: "telegram", source: "test" },
      ]),
    );
  });
}
