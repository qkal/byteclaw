import type { Client } from "@buape/carbon";
import {
  type BaseCommand,
  type BaseMessageInteractiveComponent,
  type Modal,
  type Plugin,
  ReadyListener,
} from "@buape/carbon";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { VoicePlugin } from "@buape/carbon/voice";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/config-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createDiscordRequestClient } from "../proxy-request-client.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import type { createDiscordAutoPresenceController } from "./auto-presence.js";
import type { DiscordDmPolicy } from "./dm-command-auth.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import type { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import type { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import {
  DiscordMessageListener,
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  DiscordThreadUpdateListener,
  registerDiscordListener,
} from "./listeners.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";

type DiscordAutoPresenceController = ReturnType<typeof createDiscordAutoPresenceController>;
interface DiscordListenerConfig {
  dangerouslyAllowNameMatching?: boolean;
  intents?: { presence?: boolean };
}
type CreateClientFn = (
  options: ConstructorParameters<typeof Client>[0],
  handlers: ConstructorParameters<typeof Client>[1],
  plugins: ConstructorParameters<typeof Client>[2],
) => Client;

type ListenerCompatClient = Client & {
  plugins?: { id: string; plugin: Plugin }[];
  registerListener?: (listener: object) => object;
  unregisterListener?: (listener: object) => boolean;
};

function withLegacyListenerCompat(client: Client): ListenerCompatClient {
  const compatClient = client as ListenerCompatClient;
  if (!compatClient.registerListener) {
    compatClient.registerListener = (listener: object) => {
      if (!compatClient.listeners.includes(listener as never)) {
        compatClient.listeners.push(listener as never);
      }
      return listener;
    };
  }
  if (!compatClient.unregisterListener) {
    compatClient.unregisterListener = (listener: object) => {
      const index = compatClient.listeners.indexOf(listener as never);
      if (index === -1) {
        return false;
      }
      compatClient.listeners.splice(index, 1);
      return true;
    };
  }
  return compatClient;
}

function registerLatePlugin(client: Client, plugin: Plugin) {
  const compatClient = withLegacyListenerCompat(client);
  void plugin.registerClient?.(compatClient);
  void plugin.registerRoutes?.(compatClient);
  if (!compatClient.plugins?.some((entry) => entry.id === plugin.id)) {
    compatClient.plugins?.push({ id: plugin.id, plugin });
  }
}

export function createDiscordStatusReadyListener(params: {
  discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0];
  getAutoPresenceController: () => DiscordAutoPresenceController | null;
}): ReadyListener {
  return new (class DiscordStatusReadyListener extends ReadyListener {
    async handle(_data: unknown, client: Client) {
      const autoPresenceController = params.getAutoPresenceController();
      if (autoPresenceController?.enabled) {
        autoPresenceController.refresh();
        return;
      }

      const gateway = client.getPlugin<GatewayPlugin>("gateway");
      if (!gateway) {
        return;
      }

      const presence = resolveDiscordPresenceUpdate(params.discordConfig);
      if (!presence) {
        return;
      }

      gateway.updatePresence(presence);
    }
  })();
}

export function createDiscordMonitorClient(params: {
  accountId: string;
  applicationId: string;
  token: string;
  proxyFetch?: typeof fetch;
  commands: BaseCommand[];
  components: BaseMessageInteractiveComponent[];
  modals: Modal[];
  voiceEnabled: boolean;
  discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0] & {
    eventQueue?: { listenerTimeout?: number };
  };
  runtime: RuntimeEnv;
  createClient: CreateClientFn;
  createGatewayPlugin: typeof createDiscordGatewayPlugin;
  createGatewaySupervisor: typeof createDiscordGatewaySupervisor;
  createAutoPresenceController: typeof createDiscordAutoPresenceController;
  isDisallowedIntentsError: (err: unknown) => boolean;
}) {
  let autoPresenceController: DiscordAutoPresenceController | null = null;
  const clientPlugins: Plugin[] = [
    params.createGatewayPlugin({
      discordConfig: params.discordConfig,
      runtime: params.runtime,
    }),
  ];
  if (params.voiceEnabled) {
    clientPlugins.push(new VoicePlugin());
  }
  const voicePlugin = clientPlugins.find((plugin) => plugin.id === "voice");
  const constructorPlugins = voicePlugin
    ? clientPlugins.filter((plugin) => plugin !== voicePlugin)
    : clientPlugins;

  // Pass eventQueue config to Carbon so the gateway listener budget can be tuned.
  // Default listenerTimeout is 120s (Carbon defaults to 30s, which is too short for some
  // Discord normalization/enqueue work).
  const eventQueueOpts = {
    listenerTimeout: 120_000,
    ...params.discordConfig.eventQueue,
  };
  const readyListener = createDiscordStatusReadyListener({
    discordConfig: params.discordConfig,
    getAutoPresenceController: () => autoPresenceController,
  });
  const client = params.createClient(
    {
      autoDeploy: false,
      baseUrl: "http://localhost",
      clientId: params.applicationId,
      deploySecret: "a",
      eventQueue: eventQueueOpts,
      publicKey: "a",
      token: params.token,
    },
    {
      commands: params.commands,
      components: params.components,
      listeners: [readyListener],
      modals: params.modals,
    },
    constructorPlugins,
  );
  if (voicePlugin) {
    registerLatePlugin(client, voicePlugin);
  }
  if (params.proxyFetch) {
    client.rest = createDiscordRequestClient(params.token, {
      fetch: params.proxyFetch,
    });
  }
  const gateway = client.getPlugin<GatewayPlugin>("gateway") as MutableDiscordGateway | undefined;
  const gatewaySupervisor = params.createGatewaySupervisor({
    gateway,
    isDisallowedIntentsError: params.isDisallowedIntentsError,
    runtime: params.runtime,
  });

  if (gateway) {
    autoPresenceController = params.createAutoPresenceController({
      accountId: params.accountId,
      discordConfig: params.discordConfig,
      gateway,
      log: (message) => params.runtime.log?.(message),
    });
    autoPresenceController.start();
  }

  return {
    autoPresenceController,
    client,
    eventQueueOpts,
    gateway,
    gatewaySupervisor,
  };
}

export async function fetchDiscordBotIdentity(params: {
  client: Pick<Client, "fetchUser">;
  runtime: RuntimeEnv;
  logStartupPhase: (phase: string, details?: string) => void;
}) {
  params.logStartupPhase("fetch-bot-identity:start");
  try {
    const botUser = await params.client.fetchUser("@me");
    const botUserId = botUser?.id;
    const botUserName =
      normalizeOptionalString(botUser?.username) ?? normalizeOptionalString(botUser?.globalName);
    params.logStartupPhase(
      "fetch-bot-identity:done",
      `botUserId=${botUserId ?? "<missing>"} botUserName=${botUserName ?? "<missing>"}`,
    );
    return { botUserId, botUserName };
  } catch (error) {
    params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(error)}`));
    params.logStartupPhase("fetch-bot-identity:error", String(error));
    return { botUserId: undefined, botUserName: undefined };
  }
}

export function registerDiscordMonitorListeners(params: {
  cfg: OpenClawConfig;
  client: Pick<Client, "listeners">;
  accountId: string;
  discordConfig: DiscordListenerConfig;
  runtime: RuntimeEnv;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  dmPolicy: DiscordDmPolicy;
  allowFrom?: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  logger: NonNullable<ConstructorParameters<typeof DiscordMessageListener>[1]>;
  messageHandler: ConstructorParameters<typeof DiscordMessageListener>[0];
  trackInboundEvent?: () => void;
  eventQueueListenerTimeoutMs?: number;
}) {
  registerDiscordListener(
    params.client.listeners,
    new DiscordMessageListener(params.messageHandler, params.logger, params.trackInboundEvent, {
      timeoutMs: params.eventQueueListenerTimeoutMs,
    }),
  );

  const reactionListenerOptions: ConstructorParameters<typeof DiscordReactionListener>[0] = {
    accountId: params.accountId,
    allowFrom: params.allowFrom ?? [],
    allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig),
    botUserId: params.botUserId,
    cfg: params.cfg,
    dmEnabled: params.dmEnabled,
    dmPolicy: params.dmPolicy,
    groupDmChannels: params.groupDmChannels ?? [],
    groupDmEnabled: params.groupDmEnabled,
    groupPolicy: params.groupPolicy,
    guildEntries: params.guildEntries,
    logger: params.logger,
    onEvent: params.trackInboundEvent,
    runtime: params.runtime,
  };
  registerDiscordListener(
    params.client.listeners,
    new DiscordReactionListener(reactionListenerOptions),
  );
  registerDiscordListener(
    params.client.listeners,
    new DiscordReactionRemoveListener(reactionListenerOptions),
  );
  registerDiscordListener(
    params.client.listeners,
    new DiscordThreadUpdateListener(params.cfg, params.accountId, params.logger),
  );

  if (params.discordConfig.intents?.presence) {
    registerDiscordListener(
      params.client.listeners,
      new DiscordPresenceListener({ accountId: params.accountId, logger: params.logger }),
    );
    params.runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
  }
}
