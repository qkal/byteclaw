import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "../../config/mcp-config.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parseMcpCommand } from "./mcp-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export const handleMcpCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const mcpCommand = parseMcpCommand(params.command.commandBodyNormalized);
  if (!mcpCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/mcp");
  if (unauthorized) {
    return unauthorized;
  }
  const allowInternalReadOnlyShow =
    mcpCommand.action === "show" && isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnlyShow ? null : rejectNonOwnerCommand(params, "/mcp");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    configKey: "mcp",
    label: "/mcp",
  });
  if (disabled) {
    return disabled;
  }
  if (mcpCommand.action === "error") {
    return {
      reply: { text: `⚠️ ${mcpCommand.message}` },
      shouldContinue: false,
    };
  }

  if (mcpCommand.action === "show") {
    const loaded = await listConfiguredMcpServers();
    if (!loaded.ok) {
      return {
        reply: { text: `⚠️ ${loaded.error}` },
        shouldContinue: false,
      };
    }
    if (mcpCommand.name) {
      const server = loaded.mcpServers[mcpCommand.name];
      if (!server) {
        return {
          reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${loaded.path}.` },
          shouldContinue: false,
        };
      }
      return {
        reply: {
          text: renderJsonBlock(`🔌 MCP server "${mcpCommand.name}" (${loaded.path})`, server),
        },
        shouldContinue: false,
      };
    }
    if (Object.keys(loaded.mcpServers).length === 0) {
      return {
        reply: { text: `🔌 No MCP servers configured in ${loaded.path}.` },
        shouldContinue: false,
      };
    }
    return {
      reply: {
        text: renderJsonBlock(`🔌 MCP servers (${loaded.path})`, loaded.mcpServers),
      },
      shouldContinue: false,
    };
  }

  const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
    allowedScopes: ["operator.admin"],
    label: "/mcp write",
    missingText: "❌ /mcp set|unset requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  if (mcpCommand.action === "set") {
    const result = await setConfiguredMcpServer({
      name: mcpCommand.name,
      server: mcpCommand.value,
    });
    if (!result.ok) {
      return {
        reply: { text: `⚠️ ${result.error}` },
        shouldContinue: false,
      };
    }
    return {
      reply: {
        text: `🔌 MCP server "${mcpCommand.name}" saved to ${result.path}.`,
      },
      shouldContinue: false,
    };
  }

  const result = await unsetConfiguredMcpServer({ name: mcpCommand.name });
  if (!result.ok) {
    return {
      reply: { text: `⚠️ ${result.error}` },
      shouldContinue: false,
    };
  }
  if (!result.removed) {
    return {
      reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${result.path}.` },
      shouldContinue: false,
    };
  }
  return {
    reply: { text: `🔌 MCP server "${mcpCommand.name}" removed from ${result.path}.` },
    shouldContinue: false,
  };
};
