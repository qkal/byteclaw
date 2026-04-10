import type { Client, Plugin } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";

const { registerVoiceClientSpy } = vi.hoisted(() => ({
  registerVoiceClientSpy: vi.fn(),
}));

vi.mock("@buape/carbon/voice", () => ({
  VoicePlugin: class VoicePlugin {
    id = "voice";

    registerClient(client: {
      getPlugin: (id: string) => unknown;
      registerListener: (listener: object) => object;
      unregisterListener: (listener: object) => boolean;
    }) {
      registerVoiceClientSpy(client);
      if (!client.getPlugin("gateway")) {
        throw new Error("gateway plugin missing");
      }
      client.registerListener({ type: "legacy-voice-listener" });
    }
  },
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  isDangerousNameMatchingEnabled: () => false,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalString: (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  },
}));

vi.mock("../proxy-request-client.js", () => ({
  createDiscordRequestClient: vi.fn(),
}));

vi.mock("./auto-presence.js", () => ({
  createDiscordAutoPresenceController: vi.fn(),
}));

vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: vi.fn(),
}));

vi.mock("./gateway-supervisor.js", () => ({
  createDiscordGatewaySupervisor: vi.fn(),
}));

vi.mock("./listeners.js", () => ({
  DiscordMessageListener: class DiscordMessageListener {},
  DiscordPresenceListener: class DiscordPresenceListener {},
  DiscordReactionListener: class DiscordReactionListener {},
  DiscordReactionRemoveListener: class DiscordReactionRemoveListener {},
  DiscordThreadUpdateListener: class DiscordThreadUpdateListener {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: vi.fn(() => undefined),
}));

import { createDiscordMonitorClient } from "./provider.startup.js";

describe("createDiscordMonitorClient", () => {
  it("adds listener compat for legacy voice plugins", () => {
    registerVoiceClientSpy.mockReset();

    const gatewayPlugin = {
      id: "gateway",
      registerClient: vi.fn(),
      registerRoutes: vi.fn(),
    } as Plugin;

    const result = createDiscordMonitorClient({
      accountId: "default",
      applicationId: "app-1",
      commands: [],
      components: [],
      createAutoPresenceController: () =>
        ({
          enabled: false,
          refresh: vi.fn(),
          runNow: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }) as never,
      createClient: (_options, handlers, plugins = []) => {
        const pluginRegistry = plugins.map((plugin) => ({ id: plugin.id, plugin }));
        return {
          getPlugin: (id: string) => pluginRegistry.find((entry) => entry.id === id)?.plugin,
          listeners: [...(handlers.listeners ?? [])],
          plugins: pluginRegistry,
        } as Client;
      },
      createGatewayPlugin: () => gatewayPlugin as never,
      createGatewaySupervisor: () => ({ handleError: vi.fn(), shutdown: vi.fn() }) as never,
      discordConfig: {},
      isDisallowedIntentsError: () => false,
      modals: [],
      runtime: {
        error: vi.fn(),
        exit: vi.fn(),
        log: vi.fn(),
      },
      token: "token-1",
      voiceEnabled: true,
    });

    expect(registerVoiceClientSpy).toHaveBeenCalledTimes(1);
    expect(result.client.listeners).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "legacy-voice-listener" })]),
    );
  });
});
