import { isMcpConfigRecord, toMcpStringArray, toMcpStringRecord } from "./mcp-config-shared.js";

interface StdioMcpServerLaunchConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

type StdioMcpServerLaunchResult =
  | { ok: true; config: StdioMcpServerLaunchConfig }
  | { ok: false; reason: string };

export function resolveStdioMcpServerLaunchConfig(raw: unknown): StdioMcpServerLaunchResult {
  if (!isMcpConfigRecord(raw)) {
    return { ok: false, reason: "server config must be an object" };
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    if (typeof raw.url === "string" && raw.url.trim().length > 0) {
      return {
        ok: false,
        reason: "not a stdio server (has url)",
      };
    }
    return { ok: false, reason: "its command is missing" };
  }
  const cwd =
    typeof raw.cwd === "string" && raw.cwd.trim().length > 0
      ? raw.cwd
      : (typeof raw.workingDirectory === "string" && raw.workingDirectory.trim().length > 0
        ? raw.workingDirectory
        : undefined);
  return {
    config: {
      args: toMcpStringArray(raw.args),
      command: raw.command,
      cwd,
      env: toMcpStringRecord(raw.env),
    },
    ok: true,
  };
}

export function describeStdioMcpServerLaunchConfig(config: StdioMcpServerLaunchConfig): string {
  const args =
    Array.isArray(config.args) && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
  const cwd = config.cwd ? ` (cwd=${config.cwd})` : "";
  return `${config.command}${args}${cwd}`;
}

export type { StdioMcpServerLaunchConfig, StdioMcpServerLaunchResult };
