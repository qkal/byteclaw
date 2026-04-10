import { isRecord } from "../utils.js";
import { readSourceConfigSnapshot } from "./io.js";
import { replaceConfigFile } from "./mutate.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export type ConfigMcpServers = Record<string, Record<string, unknown>>;

type ConfigMcpReadResult =
  | {
      ok: true;
      path: string;
      config: OpenClawConfig;
      mcpServers: ConfigMcpServers;
      baseHash?: string;
    }
  | { ok: false; path: string; error: string };

type ConfigMcpWriteResult =
  | {
      ok: true;
      path: string;
      config: OpenClawConfig;
      mcpServers: ConfigMcpServers;
      removed?: boolean;
    }
  | { ok: false; path: string; error: string };

export function normalizeConfiguredMcpServers(value: unknown): ConfigMcpServers {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, server]) => isRecord(server))
      .map(([name, server]) => [name, { ...(server as Record<string, unknown>) }]),
  );
}

export async function listConfiguredMcpServers(): Promise<ConfigMcpReadResult> {
  const snapshot = await readSourceConfigSnapshot();
  if (!snapshot.valid) {
    return {
      error: "Config file is invalid; fix it before using MCP config commands.",
      ok: false,
      path: snapshot.path,
    };
  }
  const sourceConfig = snapshot.sourceConfig ?? snapshot.resolved;
  return {
    baseHash: snapshot.hash,
    config: structuredClone(sourceConfig),
    mcpServers: normalizeConfiguredMcpServers(sourceConfig.mcp?.servers),
    ok: true,
    path: snapshot.path,
  };
}

export async function setConfiguredMcpServer(params: {
  name: string;
  server: unknown;
}): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { error: "MCP server name is required.", ok: false, path: "" };
  }
  if (!isRecord(params.server)) {
    return { error: "MCP server config must be a JSON object.", ok: false, path: "" };
  }

  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return loaded;
  }

  const next = structuredClone(loaded.config);
  const servers = normalizeConfiguredMcpServers(next.mcp?.servers);
  servers[name] = { ...params.server };
  next.mcp = {
    ...next.mcp,
    servers,
  };

  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      error: `Config invalid after MCP set (${issue.path}: ${issue.message}).`,
      ok: false,
      path: loaded.path,
    };
  }
  await replaceConfigFile({
    baseHash: loaded.baseHash,
    nextConfig: validated.config,
  });
  return {
    config: validated.config,
    mcpServers: servers,
    ok: true,
    path: loaded.path,
  };
}

export async function unsetConfiguredMcpServer(params: {
  name: string;
}): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { error: "MCP server name is required.", ok: false, path: "" };
  }

  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return loaded;
  }
  if (!Object.hasOwn(loaded.mcpServers, name)) {
    return {
      config: loaded.config,
      mcpServers: loaded.mcpServers,
      ok: true,
      path: loaded.path,
      removed: false,
    };
  }

  const next = structuredClone(loaded.config);
  const servers = normalizeConfiguredMcpServers(next.mcp?.servers);
  delete servers[name];
  if (Object.keys(servers).length > 0) {
    next.mcp = {
      ...next.mcp,
      servers,
    };
  } else if (next.mcp) {
    delete next.mcp.servers;
    if (Object.keys(next.mcp).length === 0) {
      delete next.mcp;
    }
  }

  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      error: `Config invalid after MCP unset (${issue.path}: ${issue.message}).`,
      ok: false,
      path: loaded.path,
    };
  }
  await replaceConfigFile({
    baseHash: loaded.baseHash,
    nextConfig: validated.config,
  });
  return {
    config: validated.config,
    mcpServers: servers,
    ok: true,
    path: loaded.path,
    removed: true,
  };
}
