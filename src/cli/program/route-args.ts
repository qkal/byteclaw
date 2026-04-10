import { isValueToken } from "../../infra/cli-root-options.js";
import {
  getCommandPositionalsWithRootOptions,
  getFlagValue,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
} from "../argv.js";

interface OptionalFlagParse {
  ok: boolean;
  value?: string;
}

function parseOptionalFlagValue(argv: string[], name: string): OptionalFlagParse {
  const value = getFlagValue(argv, name);
  if (value === null) {
    return { ok: false };
  }
  return { ok: true, value };
}

function parseRepeatedFlagValues(argv: string[], name: string): string[] | null {
  const values: string[] = [];
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === "--") {
      break;
    }
    if (arg === name) {
      const next = args[i + 1];
      if (!isValueToken(next)) {
        return null;
      }
      values.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1).trim();
      if (!value) {
        return null;
      }
      values.push(value);
    }
  }
  return values;
}

function parseSinglePositional(
  argv: string[],
  params: {
    commandPath: string[];
    booleanFlags?: string[];
  },
): string | null {
  const positionals = getCommandPositionalsWithRootOptions(argv, params);
  if (!positionals || positionals.length !== 1) {
    return null;
  }
  return positionals[0] ?? null;
}

export function parseHealthRouteArgs(argv: string[]) {
  const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
  if (timeoutMs === null) {
    return null;
  }
  return {
    json: hasFlag(argv, "--json"),
    timeoutMs,
    verbose: getVerboseFlag(argv, { includeDebug: true }),
  };
}

export function parseStatusRouteArgs(argv: string[]) {
  const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
  if (timeoutMs === null) {
    return null;
  }
  return {
    all: hasFlag(argv, "--all"),
    deep: hasFlag(argv, "--deep"),
    json: hasFlag(argv, "--json"),
    timeoutMs,
    usage: hasFlag(argv, "--usage"),
    verbose: getVerboseFlag(argv, { includeDebug: true }),
  };
}

export function parseGatewayStatusRouteArgs(argv: string[]) {
  const url = parseOptionalFlagValue(argv, "--url");
  if (!url.ok) {
    return null;
  }
  const token = parseOptionalFlagValue(argv, "--token");
  if (!token.ok) {
    return null;
  }
  const password = parseOptionalFlagValue(argv, "--password");
  if (!password.ok) {
    return null;
  }
  const timeout = parseOptionalFlagValue(argv, "--timeout");
  if (!timeout.ok) {
    return null;
  }
  const ssh = parseOptionalFlagValue(argv, "--ssh");
  if (!ssh.ok || ssh.value !== undefined) {
    return null;
  }
  const sshIdentity = parseOptionalFlagValue(argv, "--ssh-identity");
  if (!sshIdentity.ok || sshIdentity.value !== undefined) {
    return null;
  }
  if (hasFlag(argv, "--ssh-auto")) {
    return null;
  }
  return {
    deep: hasFlag(argv, "--deep"),
    json: hasFlag(argv, "--json"),
    probe: !hasFlag(argv, "--no-probe"),
    requireRpc: hasFlag(argv, "--require-rpc"),
    rpc: {
      password: password.value,
      timeout: timeout.value,
      token: token.value,
      url: url.value,
    },
  };
}

export function parseSessionsRouteArgs(argv: string[]) {
  const agent = parseOptionalFlagValue(argv, "--agent");
  if (!agent.ok) {
    return null;
  }
  const store = parseOptionalFlagValue(argv, "--store");
  if (!store.ok) {
    return null;
  }
  const active = parseOptionalFlagValue(argv, "--active");
  if (!active.ok) {
    return null;
  }
  return {
    active: active.value,
    agent: agent.value,
    allAgents: hasFlag(argv, "--all-agents"),
    json: hasFlag(argv, "--json"),
    store: store.value,
  };
}

export function parseAgentsListRouteArgs(argv: string[]) {
  return {
    bindings: hasFlag(argv, "--bindings"),
    json: hasFlag(argv, "--json"),
  };
}

export function parseConfigGetRouteArgs(argv: string[]) {
  const path = parseSinglePositional(argv, {
    booleanFlags: ["--json"],
    commandPath: ["config", "get"],
  });
  if (!path) {
    return null;
  }
  return {
    json: hasFlag(argv, "--json"),
    path,
  };
}

export function parseConfigUnsetRouteArgs(argv: string[]) {
  const path = parseSinglePositional(argv, {
    commandPath: ["config", "unset"],
  });
  if (!path) {
    return null;
  }
  return { path };
}

export function parseModelsListRouteArgs(argv: string[]) {
  const provider = parseOptionalFlagValue(argv, "--provider");
  if (!provider.ok) {
    return null;
  }
  return {
    all: hasFlag(argv, "--all"),
    json: hasFlag(argv, "--json"),
    local: hasFlag(argv, "--local"),
    plain: hasFlag(argv, "--plain"),
    provider: provider.value,
  };
}

export function parseModelsStatusRouteArgs(argv: string[]) {
  const probeProvider = parseOptionalFlagValue(argv, "--probe-provider");
  if (!probeProvider.ok) {
    return null;
  }
  const probeTimeout = parseOptionalFlagValue(argv, "--probe-timeout");
  if (!probeTimeout.ok) {
    return null;
  }
  const probeConcurrency = parseOptionalFlagValue(argv, "--probe-concurrency");
  if (!probeConcurrency.ok) {
    return null;
  }
  const probeMaxTokens = parseOptionalFlagValue(argv, "--probe-max-tokens");
  if (!probeMaxTokens.ok) {
    return null;
  }
  const agent = parseOptionalFlagValue(argv, "--agent");
  if (!agent.ok) {
    return null;
  }
  const probeProfileValues = parseRepeatedFlagValues(argv, "--probe-profile");
  if (probeProfileValues === null) {
    return null;
  }
  const probeProfile =
    probeProfileValues.length === 0
      ? undefined
      : (probeProfileValues.length === 1
        ? probeProfileValues[0]
        : probeProfileValues);
  return {
    agent: agent.value,
    check: hasFlag(argv, "--check"),
    json: hasFlag(argv, "--json"),
    plain: hasFlag(argv, "--plain"),
    probe: hasFlag(argv, "--probe"),
    probeConcurrency: probeConcurrency.value,
    probeMaxTokens: probeMaxTokens.value,
    probeProfile,
    probeProvider: probeProvider.value,
    probeTimeout: probeTimeout.value,
  };
}
