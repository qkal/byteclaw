import { afterEach, expect, test } from "vitest";
import { getChannelPlugin } from "../channels/plugins/index.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createOutboundTestPlugin } from "../test-utils/channel-plugins.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const whatsappOutbound = {
  deliveryMode: "direct" as const,
  sendMedia: async () => ({ channel: "whatsapp", messageId: "media-1" }),
  sendText: async () => ({ channel: "whatsapp", messageId: "text-1" }),
};

const replacementPlugin = createOutboundTestPlugin({
  id: "whatsapp",
  label: "WhatsApp Replacement",
  outbound: whatsappOutbound,
});

const replacementRegistry = createRegistry([
  {
    plugin: replacementPlugin,
    pluginId: "whatsapp",
    source: "test-replacement",
  },
]);

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

test("minimal gateway tracks later channel registry updates", async () => {
  const prevRegistry = getActivePluginRegistry();
  const prevVitest = process.env.VITEST;
  resetPluginRuntimeStateForTest();
  process.env.VITEST = "1";
  const port = await getFreePort();
  const server = await startGatewayServer(port);
  try {
    expect(getChannelPlugin("whatsapp")).not.toBe(replacementPlugin);
    setActivePluginRegistry(replacementRegistry);
    expect(getChannelPlugin("whatsapp")).toBe(replacementPlugin);
  } finally {
    await server.close();
    process.env.VITEST = prevVitest;
    resetPluginRuntimeStateForTest();
    if (prevRegistry) {
      setActivePluginRegistry(prevRegistry);
    }
  }
});
