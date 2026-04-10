import { resolveConfigWriteTargetFromPath } from "../../channels/plugins/config-writes.js";
import { normalizeChannelId } from "../../channels/registry.js";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import {
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "../../config/runtime-overrides.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveChannelAccountId } from "./channel-context.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parseConfigCommand } from "./config-commands.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";
import { parseDebugCommand } from "./debug-commands.js";

export const handleConfigCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const configCommand = parseConfigCommand(params.command.commandBodyNormalized);
  if (!configCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/config");
  if (unauthorized) {
    return unauthorized;
  }
  const allowInternalReadOnlyShow =
    configCommand.action === "show" && isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnlyShow ? null : rejectNonOwnerCommand(params, "/config");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    configKey: "config",
    label: "/config",
  });
  if (disabled) {
    return disabled;
  }
  if (configCommand.action === "error") {
    return {
      reply: { text: `⚠️ ${configCommand.message}` },
      shouldContinue: false,
    };
  }

  let parsedWritePath: string[] | undefined;
  if (configCommand.action === "set" || configCommand.action === "unset") {
    const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
      allowedScopes: ["operator.admin"],
      label: "/config write",
      missingText: "❌ /config set|unset requires operator.admin for gateway clients.",
    });
    if (missingAdminScope) {
      return missingAdminScope;
    }
    const parsedPath = parseConfigPath(configCommand.path);
    if (!parsedPath.ok || !parsedPath.path) {
      return {
        reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
        shouldContinue: false,
      };
    }
    parsedWritePath = parsedPath.path;
    const channelId = params.command.channelId ?? normalizeChannelId(params.command.channel);
    const deniedText = resolveConfigWriteDeniedText({
      accountId: resolveChannelAccountId({
        cfg: params.cfg,
        command: params.command,
        ctx: params.ctx,
      }),
      cfg: params.cfg,
      channel: params.command.channel,
      channelId,
      gatewayClientScopes: params.ctx.GatewayClientScopes,
      target: resolveConfigWriteTargetFromPath(parsedWritePath),
    });
    if (deniedText) {
      return {
        reply: {
          text: deniedText,
        },
        shouldContinue: false,
      };
    }
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return {
      reply: {
        text: "⚠️ Config file is invalid; fix it before using /config.",
      },
      shouldContinue: false,
    };
  }
  const parsedBase = structuredClone(snapshot.parsed as Record<string, unknown>);

  if (configCommand.action === "show") {
    const pathRaw = normalizeOptionalString(configCommand.path);
    if (pathRaw) {
      const parsedPath = parseConfigPath(pathRaw);
      if (!parsedPath.ok || !parsedPath.path) {
        return {
          reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
          shouldContinue: false,
        };
      }
      const value = getConfigValueAtPath(parsedBase, parsedPath.path);
      const rendered = JSON.stringify(value ?? null, null, 2);
      return {
        reply: {
          text: `⚙️ Config ${pathRaw}:\n\`\`\`json\n${rendered}\n\`\`\``,
        },
        shouldContinue: false,
      };
    }
    const json = JSON.stringify(parsedBase, null, 2);
    return {
      reply: { text: `⚙️ Config (raw):\n\`\`\`json\n${json}\n\`\`\`` },
      shouldContinue: false,
    };
  }

  if (configCommand.action === "unset") {
    const removed = unsetConfigValueAtPath(parsedBase, parsedWritePath ?? []);
    if (!removed) {
      return {
        reply: { text: `⚙️ No config value found for ${configCommand.path}.` },
        shouldContinue: false,
      };
    }
    const validated = validateConfigObjectWithPlugins(parsedBase);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return {
        reply: {
          text: `⚠️ Config invalid after unset (${issue.path}: ${issue.message}).`,
        },
        shouldContinue: false,
      };
    }
    await writeConfigFile(validated.config);
    return {
      reply: { text: `⚙️ Config updated: ${configCommand.path} removed.` },
      shouldContinue: false,
    };
  }

  if (configCommand.action === "set") {
    setConfigValueAtPath(parsedBase, parsedWritePath ?? [], configCommand.value);
    const validated = validateConfigObjectWithPlugins(parsedBase);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return {
        reply: {
          text: `⚠️ Config invalid after set (${issue.path}: ${issue.message}).`,
        },
        shouldContinue: false,
      };
    }
    await writeConfigFile(validated.config);
    const valueLabel =
      typeof configCommand.value === "string"
        ? `"${configCommand.value}"`
        : JSON.stringify(configCommand.value);
    return {
      reply: {
        text: `⚙️ Config updated: ${configCommand.path}=${valueLabel ?? "null"}`,
      },
      shouldContinue: false,
    };
  }

  return null;
};

export const handleDebugCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const debugCommand = parseDebugCommand(params.command.commandBodyNormalized);
  if (!debugCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/debug");
  if (unauthorized) {
    return unauthorized;
  }
  const nonOwner = rejectNonOwnerCommand(params, "/debug");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    configKey: "debug",
    label: "/debug",
  });
  if (disabled) {
    return disabled;
  }
  if (debugCommand.action === "error") {
    return {
      reply: { text: `⚠️ ${debugCommand.message}` },
      shouldContinue: false,
    };
  }
  if (debugCommand.action === "show") {
    const overrides = getConfigOverrides();
    const hasOverrides = Object.keys(overrides).length > 0;
    if (!hasOverrides) {
      return {
        reply: { text: "⚙️ Debug overrides: (none)" },
        shouldContinue: false,
      };
    }
    const json = JSON.stringify(overrides, null, 2);
    return {
      reply: {
        text: `⚙️ Debug overrides (memory-only):\n\`\`\`json\n${json}\n\`\`\``,
      },
      shouldContinue: false,
    };
  }
  if (debugCommand.action === "reset") {
    resetConfigOverrides();
    return {
      reply: { text: "⚙️ Debug overrides cleared; using config on disk." },
      shouldContinue: false,
    };
  }
  if (debugCommand.action === "unset") {
    const result = unsetConfigOverride(debugCommand.path);
    if (!result.ok) {
      return {
        reply: { text: `⚠️ ${result.error ?? "Invalid path."}` },
        shouldContinue: false,
      };
    }
    if (!result.removed) {
      return {
        reply: {
          text: `⚙️ No debug override found for ${debugCommand.path}.`,
        },
        shouldContinue: false,
      };
    }
    return {
      reply: { text: `⚙️ Debug override removed for ${debugCommand.path}.` },
      shouldContinue: false,
    };
  }
  if (debugCommand.action === "set") {
    const result = setConfigOverride(debugCommand.path, debugCommand.value);
    if (!result.ok) {
      return {
        reply: { text: `⚠️ ${result.error ?? "Invalid override."}` },
        shouldContinue: false,
      };
    }
    const valueLabel =
      typeof debugCommand.value === "string"
        ? `"${debugCommand.value}"`
        : JSON.stringify(debugCommand.value);
    return {
      reply: {
        text: `⚙️ Debug override set: ${debugCommand.path}=${valueLabel ?? "null"}`,
      },
      shouldContinue: false,
    };
  }

  return null;
};
