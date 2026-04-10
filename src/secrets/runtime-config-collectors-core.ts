import type { OpenClawConfig } from "../config/config.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import {
  resolveConfiguredMediaEntryCapabilities,
  resolveEffectiveMediaEntryCapabilities,
} from "../media-understanding/entry-capabilities.js";
import { buildMediaUnderstandingRegistry } from "../media-understanding/provider-registry.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { evaluateGatewayAuthSurfaceStates } from "./runtime-gateway-auth-surfaces.js";
import {
  type ResolverContext,
  type SecretDefaults,
  collectSecretInputAssignment,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

interface ProviderLike {
  apiKey?: unknown;
  headers?: unknown;
  request?: unknown;
  enabled?: unknown;
}

interface SkillEntryLike {
  apiKey?: unknown;
  enabled?: unknown;
}

interface ProviderRequestLike {
  headers?: unknown;
  auth?: unknown;
  proxy?: unknown;
  tls?: unknown;
}

function collectModelProviderAssignments(params: {
  providers: Record<string, ProviderLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [providerId, provider] of Object.entries(params.providers)) {
    const providerIsActive = provider.enabled !== false;
    collectSecretInputAssignment({
      active: providerIsActive,
      apply: (value) => {
        provider.apiKey = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: "provider is disabled.",
      path: `models.providers.${providerId}.apiKey`,
      value: provider.apiKey,
    });
    const headers = isRecord(provider.headers) ? provider.headers : undefined;
    if (headers) {
      for (const [headerKey, headerValue] of Object.entries(headers)) {
        collectSecretInputAssignment({
          active: providerIsActive,
          apply: (value) => {
            headers[headerKey] = value;
          },
          context: params.context,
          defaults: params.defaults,
          expected: "string",
          inactiveReason: "provider is disabled.",
          path: `models.providers.${providerId}.headers.${headerKey}`,
          value: headerValue,
        });
      }
    }

    const request = isRecord(provider.request) ? provider.request : undefined;
    if (request) {
      collectProviderRequestAssignments({
        active: providerIsActive,
        collectTransportSecrets: true,
        context: params.context,
        defaults: params.defaults,
        inactiveReason: "provider is disabled.",
        pathPrefix: `models.providers.${providerId}.request`,
        request,
      });
    }
  }
}

function collectSkillAssignments(params: {
  entries: Record<string, SkillEntryLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [skillKey, entry] of Object.entries(params.entries)) {
    collectSecretInputAssignment({
      active: entry.enabled !== false,
      apply: (value) => {
        entry.apiKey = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: "skill entry is disabled.",
      path: `skills.entries.${skillKey}.apiKey`,
      value: entry.apiKey,
    });
  }
}

function collectAgentMemorySearchAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const agents = params.config.agents as Record<string, unknown> | undefined;
  if (!isRecord(agents)) {
    return;
  }
  const defaultsConfig = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsMemorySearch = isRecord(defaultsConfig?.memorySearch)
    ? defaultsConfig.memorySearch
    : undefined;
  const defaultsEnabled = defaultsMemorySearch?.enabled !== false;

  const list = Array.isArray(agents.list) ? agents.list : [];
  let hasEnabledAgentWithoutOverride = false;
  for (const rawAgent of list) {
    if (!isRecord(rawAgent)) {
      continue;
    }
    if (rawAgent.enabled === false) {
      continue;
    }
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    if (memorySearch?.enabled === false) {
      continue;
    }
    if (!memorySearch || !Object.hasOwn(memorySearch, "remote")) {
      hasEnabledAgentWithoutOverride = true;
      continue;
    }
    const remote = isRecord(memorySearch.remote) ? memorySearch.remote : undefined;
    if (!remote || !Object.hasOwn(remote, "apiKey")) {
      hasEnabledAgentWithoutOverride = true;
      continue;
    }
  }

  if (defaultsMemorySearch && isRecord(defaultsMemorySearch.remote)) {
    const { remote } = defaultsMemorySearch;
    collectSecretInputAssignment({
      active: defaultsEnabled && (hasEnabledAgentWithoutOverride || list.length === 0),
      apply: (value) => {
        remote.apiKey = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: hasEnabledAgentWithoutOverride
        ? undefined
        : "all enabled agents override memorySearch.remote.apiKey.",
      path: "agents.defaults.memorySearch.remote.apiKey",
      value: remote.apiKey,
    });
  }

  list.forEach((rawAgent, index) => {
    if (!isRecord(rawAgent)) {
      return;
    }
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    if (!memorySearch) {
      return;
    }
    const remote = isRecord(memorySearch.remote) ? memorySearch.remote : undefined;
    if (!remote || !Object.hasOwn(remote, "apiKey")) {
      return;
    }
    const enabled = rawAgent.enabled !== false && memorySearch.enabled !== false;
    collectSecretInputAssignment({
      active: enabled,
      apply: (value) => {
        remote.apiKey = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: "agent or memorySearch override is disabled.",
      path: `agents.list.${index}.memorySearch.remote.apiKey`,
      value: remote.apiKey,
    });
  });
}

function collectTalkAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const talk = params.config.talk as Record<string, unknown> | undefined;
  if (!isRecord(talk)) {
    return;
  }
  collectSecretInputAssignment({
    apply: (value) => {
      talk.apiKey = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    path: "talk.apiKey",
    value: talk.apiKey,
  });
  const { providers } = talk;
  if (!isRecord(providers)) {
    return;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    collectSecretInputAssignment({
      apply: (value) => {
        providerConfig.apiKey = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      path: `talk.providers.${providerId}.apiKey`,
      value: providerConfig.apiKey,
    });
  }
}

function collectGatewayAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return;
  }
  const auth = isRecord(gateway.auth) ? gateway.auth : undefined;
  const remote = isRecord(gateway.remote) ? gateway.remote : undefined;
  const gatewaySurfaceStates = evaluateGatewayAuthSurfaceStates({
    config: params.config,
    defaults: params.defaults,
    env: params.context.env,
  });
  if (auth) {
    collectSecretInputAssignment({
      active: gatewaySurfaceStates["gateway.auth.token"].active,
      apply: (value) => {
        auth.token = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: gatewaySurfaceStates["gateway.auth.token"].reason,
      path: "gateway.auth.token",
      value: auth.token,
    });
    collectSecretInputAssignment({
      active: gatewaySurfaceStates["gateway.auth.password"].active,
      apply: (value) => {
        auth.password = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: gatewaySurfaceStates["gateway.auth.password"].reason,
      path: "gateway.auth.password",
      value: auth.password,
    });
  }
  if (remote) {
    collectSecretInputAssignment({
      active: gatewaySurfaceStates["gateway.remote.token"].active,
      apply: (value) => {
        remote.token = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: gatewaySurfaceStates["gateway.remote.token"].reason,
      path: "gateway.remote.token",
      value: remote.token,
    });
    collectSecretInputAssignment({
      active: gatewaySurfaceStates["gateway.remote.password"].active,
      apply: (value) => {
        remote.password = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: gatewaySurfaceStates["gateway.remote.password"].reason,
      path: "gateway.remote.password",
      value: remote.password,
    });
  }
}

function collectProviderRequestAssignments(params: {
  request: ProviderRequestLike;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
  collectTransportSecrets?: boolean;
}): void {
  const headers = isRecord(params.request.headers) ? params.request.headers : undefined;
  if (headers) {
    for (const [headerKey, headerValue] of Object.entries(headers)) {
      collectSecretInputAssignment({
        active: params.active,
        apply: (value) => {
          headers[headerKey] = value;
        },
        context: params.context,
        defaults: params.defaults,
        expected: "string",
        inactiveReason: params.inactiveReason,
        path: `${params.pathPrefix}.headers.${headerKey}`,
        value: headerValue,
      });
    }
  }

  const auth = isRecord(params.request.auth) ? params.request.auth : undefined;
  if (auth) {
    collectSecretInputAssignment({
      active: params.active,
      apply: (value) => {
        auth.token = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: params.inactiveReason,
      path: `${params.pathPrefix}.auth.token`,
      value: auth.token,
    });
    collectSecretInputAssignment({
      active: params.active,
      apply: (value) => {
        auth.value = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: params.inactiveReason,
      path: `${params.pathPrefix}.auth.value`,
      value: auth.value,
    });
  }

  const collectTlsAssignments = (tls: Record<string, unknown> | undefined, pathPrefix: string) => {
    if (!tls) {
      return;
    }
    for (const key of ["ca", "cert", "key", "passphrase"] as const) {
      collectSecretInputAssignment({
        active: params.active,
        apply: (value) => {
          tls[key] = value;
        },
        context: params.context,
        defaults: params.defaults,
        expected: "string",
        inactiveReason: params.inactiveReason,
        path: `${pathPrefix}.${key}`,
        value: tls[key],
      });
    }
  };

  if (params.collectTransportSecrets !== false) {
    collectTlsAssignments(
      isRecord(params.request.tls) ? params.request.tls : undefined,
      `${params.pathPrefix}.tls`,
    );
    const proxy = isRecord(params.request.proxy) ? params.request.proxy : undefined;
    collectTlsAssignments(
      isRecord(proxy?.tls) ? proxy.tls : undefined,
      `${params.pathPrefix}.proxy.tls`,
    );
  }
}

function collectMediaRequestAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const tools = isRecord(params.config.tools) ? params.config.tools : undefined;
  const media = isRecord(tools?.media) ? tools.media : undefined;
  if (!media) {
    return;
  }

  let providerRegistry: ReturnType<typeof buildMediaUnderstandingRegistry> | undefined;
  const getProviderRegistry = () => {
    providerRegistry ??= buildMediaUnderstandingRegistry(undefined, params.config);
    return providerRegistry;
  };
  const capabilityKeys = ["audio", "image", "video"] as const;
  const isCapabilityEnabled = (capability: (typeof capabilityKeys)[number]) =>
    (isRecord(media[capability]) ? media[capability] : undefined)?.enabled !== false;

  const collectModelAssignments = (
    models: unknown,
    pathPrefix: string,
    resolveActivity: (rawModel: Record<string, unknown>) => {
      active: boolean;
      inactiveReason: string;
    },
  ) => {
    if (!Array.isArray(models)) {
      return;
    }
    models.forEach((rawModel, index) => {
      if (!isRecord(rawModel) || !isRecord(rawModel.request)) {
        return;
      }
      const { active, inactiveReason } = resolveActivity(rawModel);
      collectProviderRequestAssignments({
        active,
        context: params.context,
        defaults: params.defaults,
        inactiveReason,
        pathPrefix: `${pathPrefix}.${index}.request`,
        request: rawModel.request,
      });
    });
  };

  collectModelAssignments(media.models, "tools.media.models", (rawModel) => {
    const entry = rawModel as MediaUnderstandingModelConfig;
    const configuredCapabilities = resolveConfiguredMediaEntryCapabilities(entry);
    const capabilities =
      configuredCapabilities ??
      resolveEffectiveMediaEntryCapabilities({
        entry,
        providerRegistry: getProviderRegistry(),
        source: "shared",
      });
    if (!capabilities || capabilities.length === 0) {
      return {
        active: false,
        inactiveReason:
          "shared media model does not declare capabilities and none could be inferred from its provider.",
      };
    }
    return {
      active: capabilities.some((capability) => isCapabilityEnabled(capability)),
      inactiveReason: `all configured media capabilities for this shared model are disabled: ${capabilities.join(", ")}.`,
    };
  });

  for (const capability of capabilityKeys) {
    const section = isRecord(media[capability]) ? media[capability] : undefined;
    const active = isCapabilityEnabled(capability);
    const inactiveReason = `${capability} media understanding is disabled.`;
    if (section && isRecord(section.request)) {
      collectProviderRequestAssignments({
        active,
        context: params.context,
        defaults: params.defaults,
        inactiveReason,
        pathPrefix: `tools.media.${capability}.request`,
        request: section.request,
      });
    }
    collectModelAssignments(section?.models, `tools.media.${capability}.models`, (rawModel) => ({
      active:
        active &&
        (() => {
          const entry = rawModel as MediaUnderstandingModelConfig;
          const configuredCapabilities = resolveConfiguredMediaEntryCapabilities(entry);
          return configuredCapabilities ? configuredCapabilities.includes(capability) : true;
        })(),
      inactiveReason: active
        ? `${capability} media model is filtered out by its configured capabilities.`
        : inactiveReason,
    }));
  }
}

function collectMessagesTtsAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const messages = params.config.messages as Record<string, unknown> | undefined;
  if (!isRecord(messages) || !isRecord(messages.tts)) {
    return;
  }
  collectTtsApiKeyAssignments({
    context: params.context,
    defaults: params.defaults,
    pathPrefix: "messages.tts",
    tts: messages.tts,
  });
}

function collectCronAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const cron = params.config.cron as Record<string, unknown> | undefined;
  if (!isRecord(cron)) {
    return;
  }
  collectSecretInputAssignment({
    apply: (value) => {
      cron.webhookToken = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    path: "cron.webhookToken",
    value: cron.webhookToken,
  });
}

function collectSandboxSshAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const agents = isRecord(params.config.agents) ? params.config.agents : undefined;
  if (!agents) {
    return;
  }
  const defaultsAgent = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsSandbox = isRecord(defaultsAgent?.sandbox) ? defaultsAgent.sandbox : undefined;
  const defaultsSsh = isRecord(defaultsSandbox?.ssh)
    ? (defaultsSandbox.ssh as Record<string, unknown>)
    : undefined;
  const defaultsBackend =
    typeof defaultsSandbox?.backend === "string" ? defaultsSandbox.backend : undefined;
  const defaultsMode = typeof defaultsSandbox?.mode === "string" ? defaultsSandbox.mode : undefined;

  const inheritedDefaultsUsage = {
    certificateData: false,
    identityData: false,
    knownHostsData: false,
  };

  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((rawAgent, index) => {
    const agentRecord = isRecord(rawAgent) ? (rawAgent as Record<string, unknown>) : null;
    if (!agentRecord || agentRecord.enabled === false) {
      return;
    }
    const sandbox = isRecord(agentRecord.sandbox) ? agentRecord.sandbox : undefined;
    const ssh = isRecord(sandbox?.ssh) ? sandbox.ssh : undefined;
    const effectiveBackend =
      (typeof sandbox?.backend === "string" ? sandbox.backend : undefined) ??
      defaultsBackend ??
      "docker";
    const effectiveMode =
      (typeof sandbox?.mode === "string" ? sandbox.mode : undefined) ?? defaultsMode ?? "off";
    const active =
      normalizeOptionalLowercaseString(effectiveBackend) === "ssh" && effectiveMode !== "off";
    for (const key of ["identityData", "certificateData", "knownHostsData"] as const) {
      if (ssh && Object.hasOwn(ssh, key)) {
        collectSecretInputAssignment({
          active,
          apply: (value) => {
            ssh[key] = value;
          },
          context: params.context,
          defaults: params.defaults,
          expected: "string",
          inactiveReason: "sandbox SSH backend is not active for this agent.",
          path: `agents.list.${index}.sandbox.ssh.${key}`,
          value: ssh[key],
        });
      } else if (active) {
        inheritedDefaultsUsage[key] = true;
      }
    }
  });

  if (!defaultsSsh) {
    return;
  }

  const defaultsActive =
    (normalizeOptionalLowercaseString(defaultsBackend) === "ssh" && defaultsMode !== "off") ||
    inheritedDefaultsUsage.identityData ||
    inheritedDefaultsUsage.certificateData ||
    inheritedDefaultsUsage.knownHostsData;
  for (const key of ["identityData", "certificateData", "knownHostsData"] as const) {
    collectSecretInputAssignment({
      active: defaultsActive || inheritedDefaultsUsage[key],
      apply: (value) => {
        defaultsSsh[key] = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: "sandbox SSH backend is not active.",
      path: `agents.defaults.sandbox.ssh.${key}`,
      value: defaultsSsh[key],
    });
  }
}

export function collectCoreConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const providers = params.config.models?.providers as Record<string, ProviderLike> | undefined;
  if (providers) {
    collectModelProviderAssignments({
      context: params.context,
      defaults: params.defaults,
      providers,
    });
  }

  const skillEntries = params.config.skills?.entries as Record<string, SkillEntryLike> | undefined;
  if (skillEntries) {
    collectSkillAssignments({
      context: params.context,
      defaults: params.defaults,
      entries: skillEntries,
    });
  }

  collectAgentMemorySearchAssignments(params);
  collectTalkAssignments(params);
  collectGatewayAssignments(params);
  collectSandboxSshAssignments(params);
  collectMessagesTtsAssignments(params);
  collectCronAssignments(params);
  collectMediaRequestAssignments(params);
}
