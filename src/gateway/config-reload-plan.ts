import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

export type ChannelKind = ChannelId;

export interface GatewayReloadPlan {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartHealthMonitor: boolean;
  restartChannels: Set<ChannelKind>;
  noopPaths: string[];
}

interface ReloadRule {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
}

type ReloadAction =
  | "reload-hooks"
  | "restart-gmail-watcher"
  | "restart-cron"
  | "restart-heartbeat"
  | "restart-health-monitor"
  | `restart-channel:${ChannelId}`;

const BASE_RELOAD_RULES: ReloadRule[] = [
  { kind: "none", prefix: "gateway.remote" },
  { kind: "none", prefix: "gateway.reload" },
  {
    actions: ["restart-health-monitor"],
    kind: "hot",
    prefix: "gateway.channelHealthCheckMinutes",
  },
  {
    actions: ["restart-health-monitor"],
    kind: "hot",
    prefix: "gateway.channelStaleEventThresholdMinutes",
  },
  {
    actions: ["restart-health-monitor"],
    kind: "hot",
    prefix: "gateway.channelMaxRestartsPerHour",
  },
  // Stuck-session warning threshold is read by the diagnostics heartbeat loop.
  { kind: "none", prefix: "diagnostics.stuckSessionWarnMs" },
  { actions: ["restart-gmail-watcher"], kind: "hot", prefix: "hooks.gmail" },
  { actions: ["reload-hooks"], kind: "hot", prefix: "hooks" },
  {
    actions: ["restart-heartbeat"],
    kind: "hot",
    prefix: "agents.defaults.heartbeat",
  },
  {
    actions: ["restart-heartbeat"],
    kind: "hot",
    prefix: "agents.defaults.models",
  },
  {
    actions: ["restart-heartbeat"],
    kind: "hot",
    prefix: "agents.defaults.model",
  },
  {
    actions: ["restart-heartbeat"],
    kind: "hot",
    prefix: "models",
  },
  {
    actions: ["restart-heartbeat"],
    kind: "hot",
    prefix: "agents.list",
  },
  { actions: ["restart-heartbeat"], kind: "hot", prefix: "agent.heartbeat" },
  { actions: ["restart-cron"], kind: "hot", prefix: "cron" },
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { kind: "none", prefix: "meta" },
  { kind: "none", prefix: "identity" },
  { kind: "none", prefix: "wizard" },
  { kind: "none", prefix: "logging" },
  { kind: "none", prefix: "agents" },
  { kind: "none", prefix: "tools" },
  { kind: "none", prefix: "bindings" },
  { kind: "none", prefix: "audio" },
  { kind: "none", prefix: "agent" },
  { kind: "none", prefix: "routing" },
  { kind: "none", prefix: "messages" },
  { kind: "none", prefix: "session" },
  { kind: "none", prefix: "talk" },
  { kind: "none", prefix: "skills" },
  { kind: "none", prefix: "secrets" },
  { kind: "restart", prefix: "plugins" },
  { kind: "none", prefix: "ui" },
  { kind: "restart", prefix: "gateway" },
  { kind: "restart", prefix: "discovery" },
  { kind: "restart", prefix: "canvasHost" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function listReloadRules(): ReloadRule[] {
  const registry = getActivePluginRegistry();
  if (registry !== cachedRegistry) {
    cachedReloadRules = null;
    cachedRegistry = registry;
  }
  if (cachedReloadRules) {
    return cachedReloadRules;
  }
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    ...(plugin.reload?.configPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        actions: [`restart-channel:${plugin.id}` as ReloadAction],
        kind: "hot",
        prefix,
      }),
    ),
    ...(plugin.reload?.noopPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        kind: "none",
        prefix,
      }),
    ),
  ]);
  const pluginReloadRules: ReloadRule[] = (registry?.reloads ?? []).flatMap((entry) => [
    ...(entry.registration.restartPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        kind: "restart",
        prefix,
      }),
    ),
    ...(entry.registration.hotPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        kind: "hot",
        prefix,
      }),
    ),
    ...(entry.registration.noopPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        kind: "none",
        prefix,
      }),
    ),
  ]);
  const rules = [
    ...BASE_RELOAD_RULES,
    ...pluginReloadRules,
    ...channelReloadRules,
    ...BASE_RELOAD_RULES_TAIL,
  ];
  cachedReloadRules = rules;
  return rules;
}

function matchRule(path: string): ReloadRule | null {
  for (const rule of listReloadRules()) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      return rule;
    }
  }
  return null;
}

export function buildGatewayReloadPlan(changedPaths: string[]): GatewayReloadPlan {
  const plan: GatewayReloadPlan = {
    changedPaths,
    hotReasons: [],
    noopPaths: [],
    reloadHooks: false,
    restartChannels: new Set(),
    restartCron: false,
    restartGateway: false,
    restartGmailWatcher: false,
    restartHealthMonitor: false,
    restartHeartbeat: false,
    restartReasons: [],
  };

  const applyAction = (action: ReloadAction) => {
    if (action.startsWith("restart-channel:")) {
      const channel = action.slice("restart-channel:".length) as ChannelId;
      plan.restartChannels.add(channel);
      return;
    }
    switch (action) {
      case "reload-hooks": {
        plan.reloadHooks = true;
        break;
      }
      case "restart-gmail-watcher": {
        plan.restartGmailWatcher = true;
        break;
      }
      case "restart-cron": {
        plan.restartCron = true;
        break;
      }
      case "restart-heartbeat": {
        plan.restartHeartbeat = true;
        break;
      }
      case "restart-health-monitor": {
        plan.restartHealthMonitor = true;
        break;
      }
      default: {
        break;
      }
    }
  };

  for (const path of changedPaths) {
    const rule = matchRule(path);
    if (!rule) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "restart") {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule.actions ?? []) {
      applyAction(action);
    }
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}
