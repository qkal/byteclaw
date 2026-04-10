import { isGatewayConfigBypassCommandPath } from "../gateway/explicit-connection-policy.js";
import { type CliCommandPathPolicy, cliCommandCatalog } from "./command-catalog.js";
import { matchesCommandPath } from "./command-path-matches.js";

const DEFAULT_CLI_COMMAND_PATH_POLICY: CliCommandPathPolicy = {
  bypassConfigGuard: false,
  ensureCliPath: true,
  hideBanner: false,
  loadPlugins: "never",
  routeConfigGuard: "never",
};

export function resolveCliCommandPathPolicy(commandPath: string[]): CliCommandPathPolicy {
  let resolvedPolicy: CliCommandPathPolicy = { ...DEFAULT_CLI_COMMAND_PATH_POLICY };
  for (const entry of cliCommandCatalog) {
    if (!entry.policy) {
      continue;
    }
    if (!matchesCommandPath(commandPath, entry.commandPath, { exact: entry.exact })) {
      continue;
    }
    resolvedPolicy = {
      ...resolvedPolicy,
      ...entry.policy,
    };
  }
  if (isGatewayConfigBypassCommandPath(commandPath)) {
    resolvedPolicy = {
      ...resolvedPolicy,
      bypassConfigGuard: true,
    };
  }
  return resolvedPolicy;
}
