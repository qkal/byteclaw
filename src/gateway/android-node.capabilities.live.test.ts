import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { unwrapRemoteConfigSnapshot } from "../../test/helpers/gateway/android-node-capabilities-policy-config.js";
import { shouldFetchRemotePolicyConfig } from "../../test/helpers/gateway/android-node-capabilities-policy-source.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { parseNodeList, parsePairingList } from "../shared/node-list-parse.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildGatewayConnectionDetails } from "./call.js";
import { GatewayClient } from "./client.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { resolveNodeCommandAllowlist } from "./node-command-policy.js";

const LIVE = isLiveTestEnabled();
const LIVE_ANDROID_NODE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_ANDROID_NODE);
const describeLive = LIVE && LIVE_ANDROID_NODE ? describe : describe.skip;
const SKIPPED_INTERACTIVE_COMMANDS = new Set<string>();

type CommandOutcome = "success" | "error";

interface CommandContext {
  notifications: Record<string, unknown>[];
}

interface CommandProfile {
  buildParams: (ctx: CommandContext) => Record<string, unknown>;
  timeoutMs?: number;
  outcome: CommandOutcome;
  allowedErrorCodes?: string[];
  onSuccess?: (payload: unknown, ctx: CommandContext) => void;
}

interface CommandResult {
  command: string;
  ok: boolean;
  payload?: unknown;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function parseErrorCode(message: string): string {
  const trimmed = message.trim();
  const idx = trimmed.indexOf(":");
  const head = (idx !== -1 ? trimmed.slice(0, idx) : trimmed).trim();
  if (/^[A-Z0-9_]+$/.test(head)) {
    return head;
  }
  return "UNKNOWN";
}

function readGatewayErrorCode(err: unknown, fallbackMessage: string): string {
  const byField = readString(asRecord(err).gatewayCode);
  if (byField) {
    return byField;
  }
  return parseErrorCode(fallbackMessage);
}

function assertObjectPayload(command: string, payload: unknown): Record<string, unknown> {
  const obj = asRecord(payload);
  expect(Object.keys(obj).length, `${command} payload must be a JSON object`).toBeGreaterThan(0);
  return obj;
}

const COMMAND_PROFILES: Record<string, CommandProfile> = {
  "camera.clip": {
    buildParams: () => ({ durationMs: 1500, facing: "front", format: "mp4", includeAudio: false }),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("camera.clip", payload);
      expect(readString(obj.base64)).not.toBeNull();
    },
    outcome: "success",
    timeoutMs: 90_000,
  },
  "camera.list": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("camera.list", payload);
      expect(Array.isArray(obj.devices)).toBe(true);
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "camera.snap": {
    buildParams: () => ({ facing: "front", format: "jpg", maxWidth: 640, quality: 0.6 }),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("camera.snap", payload);
      expect(readString(obj.base64)).not.toBeNull();
    },
    outcome: "success",
    timeoutMs: 60_000,
  },
  "canvas.a2ui.push": {
    buildParams: () => ({ jsonl: '{"beginRendering":{}}\n' }),
    outcome: "success",
    timeoutMs: 30_000,
  },
  "canvas.a2ui.pushJSONL": {
    buildParams: () => ({ jsonl: '{"beginRendering":{}}\n' }),
    outcome: "success",
    timeoutMs: 30_000,
  },
  "canvas.a2ui.reset": {
    buildParams: () => ({}),
    outcome: "success",
    timeoutMs: 30_000,
  },
  "canvas.eval": {
    buildParams: () => ({ javaScript: "1 + 1" }),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("canvas.eval", payload);
      expect(obj.result).toBeDefined();
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "canvas.hide": {
    buildParams: () => ({}),
    outcome: "success",
    timeoutMs: 20_000,
  },
  "canvas.navigate": {
    buildParams: () => ({ url: "about:blank" }),
    outcome: "success",
    timeoutMs: 20_000,
  },
  "canvas.present": {
    buildParams: () => ({ url: "about:blank" }),
    outcome: "success",
    timeoutMs: 20_000,
  },
  "canvas.snapshot": {
    buildParams: () => ({ format: "jpeg", maxWidth: 320, quality: 0.6 }),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("canvas.snapshot", payload);
      expect(readString(obj.format)).not.toBeNull();
      expect(readString(obj.base64)).not.toBeNull();
    },
    outcome: "success",
    timeoutMs: 30_000,
  },
  "debug.ed25519": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("debug.ed25519", payload);
      expect(readString(obj.diagnostics)).not.toBeNull();
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "debug.logs": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("debug.logs", payload);
      expect(readString(obj.logs)).not.toBeNull();
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "device.health": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("device.health", payload);
      expect(asRecord(obj.memory)).toBeTruthy();
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "device.info": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("device.info", payload);
      expect(readString(obj.systemName)).not.toBeNull();
      expect(readString(obj.systemVersion)).not.toBeNull();
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "device.permissions": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("device.permissions", payload);
      expect(asRecord(obj.permissions)).toBeTruthy();
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "device.status": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      assertObjectPayload("device.status", payload);
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "location.get": {
    buildParams: () => ({ desiredAccuracy: "balanced", timeoutMs: 5000 }),
    onSuccess: (payload) => {
      assertObjectPayload("location.get", payload);
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "notifications.actions": {
    allowedErrorCodes: ["INVALID_REQUEST"],
    buildParams: () => ({}),
    outcome: "error",
    timeoutMs: 20_000,
  },
  "notifications.list": {
    buildParams: () => ({}),
    onSuccess: (payload, ctx) => {
      const obj = assertObjectPayload("notifications.list", payload);
      const notifications = Array.isArray(obj.notifications) ? obj.notifications : [];
      ctx.notifications = notifications.map((entry) => asRecord(entry));
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "sms.search": {
    buildParams: () => ({}),
    onSuccess: (payload) => {
      const obj = assertObjectPayload("sms.search", payload);
      expect(typeof obj.count === "number" || typeof obj.count === "string").toBe(true);
      expect(Array.isArray(obj.messages)).toBe(true);
    },
    outcome: "success",
    timeoutMs: 20_000,
  },
  "sms.send": {
    allowedErrorCodes: ["INVALID_REQUEST"],
    buildParams: () => ({}),
    outcome: "error",
    timeoutMs: 20_000,
  },
};

function resolveGatewayConnection() {
  const cfg = loadConfig();
  const urlOverride = readString(process.env.OPENCLAW_ANDROID_GATEWAY_URL);
  const details = buildGatewayConnectionDetails({
    config: cfg,
    ...(urlOverride ? { url: urlOverride } : {}),
  });
  const tokenOverride = readString(process.env.OPENCLAW_ANDROID_GATEWAY_TOKEN);
  const passwordOverride = readString(process.env.OPENCLAW_ANDROID_GATEWAY_PASSWORD);
  const creds = resolveGatewayCredentialsFromConfig({
    cfg,
    explicitAuth: {
      ...(tokenOverride ? { token: tokenOverride } : {}),
      ...(passwordOverride ? { password: passwordOverride } : {}),
    },
  });
  return {
    details,
    password: creds.password,
    token: creds.token,
    url: details.url,
  };
}

async function resolvePolicyConfigForRun(params: {
  client: GatewayClient;
  connectionDetails: ReturnType<typeof buildGatewayConnectionDetails>;
  loadLocalConfig?: () => OpenClawConfig;
}): Promise<OpenClawConfig> {
  if (shouldFetchRemotePolicyConfig(params.connectionDetails)) {
    const raw = await params.client.request("config.get", {});
    return unwrapRemoteConfigSnapshot(raw);
  }

  const loadLocalConfig = params.loadLocalConfig ?? loadConfig;
  return loadLocalConfig();
}

describe("resolvePolicyConfigForRun", () => {
  it("skips local config loading for remote runs", async () => {
    const request = vi.fn().mockResolvedValue({ config: { gateway: { bind: "127.0.0.1" } } });
    const loadLocalConfig = vi.fn(() => {
      throw new Error("local config should not load in remote mode");
    });

    const result = await resolvePolicyConfigForRun({
      client: { request } as unknown as GatewayClient,
      connectionDetails: {
        message: "remote",
        url: "wss://example.invalid/gateway",
        urlSource: "env override",
      },
      loadLocalConfig,
    });

    expect(loadLocalConfig).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("config.get", {});
    expect(asRecord(result.gateway)).toBeTruthy();
  });

  it("still uses local config loading for local loopback runs", async () => {
    const localConfig = { gateway: { bind: "127.0.0.1" } } as unknown as OpenClawConfig;
    const loadLocalConfig = vi.fn(() => localConfig);

    const result = await resolvePolicyConfigForRun({
      client: { request: vi.fn() } as unknown as GatewayClient,
      connectionDetails: {
        message: "local",
        url: "ws://127.0.0.1:4000/gateway",
        urlSource: "local loopback",
      },
      loadLocalConfig,
    });

    expect(loadLocalConfig).toHaveBeenCalledTimes(1);
    expect(result).toBe(localConfig);
  });
});

async function connectGatewayClient(params: {
  url: string;
  token?: string;
  password?: string;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: GatewayClient) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      resolve(client as GatewayClient);
    };

    const client = new GatewayClient({
      clientDisplayName: "android-live-test",
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      connectChallengeTimeoutMs: 0,
      mode: GATEWAY_CLIENT_MODES.TEST,
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
      onConnectError: (err) => stop(err),
      onHelloOk: () => stop(undefined, client),
      password: params.password,
      platform: "test",
      token: params.token,
      url: params.url,
    });

    const timer = setTimeout(() => stop(new Error("gateway connect timeout")), 10_000);
    timer.unref();
    client.start();
  });
}

function isAndroidNode(node: NodeListNode): boolean {
  const platform = readString(node.platform)?.toLowerCase();
  if (platform === "android") {
    return true;
  }
  const displayName = readString(node.displayName)?.toLowerCase();
  return displayName?.includes("android") === true;
}

function selectTargetNode(nodes: NodeListNode[]): NodeListNode {
  const nodeIdOverride = readString(process.env.OPENCLAW_ANDROID_NODE_ID);
  if (nodeIdOverride) {
    const match = nodes.find((node) => node.nodeId === nodeIdOverride);
    if (!match) {
      throw new Error(`OPENCLAW_ANDROID_NODE_ID not found in node.list: ${nodeIdOverride}`);
    }
    return match;
  }

  const nodeNameOverride = readString(process.env.OPENCLAW_ANDROID_NODE_NAME)?.toLowerCase();
  if (nodeNameOverride) {
    const match = nodes.find(
      (node) => readString(node.displayName)?.toLowerCase() === nodeNameOverride,
    );
    if (!match) {
      throw new Error(`OPENCLAW_ANDROID_NODE_NAME not found in node.list: ${nodeNameOverride}`);
    }
    return match;
  }

  const androidNodes = nodes.filter(isAndroidNode);
  if (androidNodes.length === 0) {
    throw new Error("no Android node found in node.list");
  }

  return [...androidNodes].toSorted((a, b) => {
    const aMs = typeof a.connectedAtMs === "number" ? a.connectedAtMs : 0;
    const bMs = typeof b.connectedAtMs === "number" ? b.connectedAtMs : 0;
    return bMs - aMs;
  })[0];
}

async function invokeNodeCommand(params: {
  client: GatewayClient;
  nodeId: string;
  command: string;
  profile: CommandProfile;
  ctx: CommandContext;
}): Promise<CommandResult> {
  const startedAt = Date.now();
  const timeoutMs = params.profile.timeoutMs ?? 20_000;
  const invokeParams = {
    command: params.command,
    idempotencyKey: randomUUID(),
    nodeId: params.nodeId,
    params: params.profile.buildParams(params.ctx),
    timeoutMs,
  };

  try {
    const raw = await params.client.request("node.invoke", invokeParams);
    const {payload} = asRecord(raw);
    return {
      command: params.command,
      durationMs: Math.max(1, Date.now() - startedAt),
      ok: true,
      payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      command: params.command,
      durationMs: Math.max(1, Date.now() - startedAt),
      errorCode: readGatewayErrorCode(error, message),
      errorMessage: message,
      ok: false,
    };
  }
}

function evaluateCommandResult(params: {
  result: CommandResult;
  profile: CommandProfile;
  ctx: CommandContext;
}): string | null {
  const { result, profile, ctx } = params;

  if (result.ok) {
    if (profile.outcome === "error") {
      return `expected error, got success`;
    }
    try {
      profile.onSuccess?.(result.payload, ctx);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  const code = result.errorCode ?? "UNKNOWN";
  if (profile.outcome === "success") {
    return `expected success, got ${code}: ${result.errorMessage ?? "unknown error"}`;
  }
  const allowed = new Set(profile.allowedErrorCodes ?? []);
  if (allowed.has(code)) {
    return null;
  }
  return `unexpected error ${code}: ${result.errorMessage ?? "unknown error"}`;
}

describeLive("android node capability integration (preconditioned)", () => {
  let client: GatewayClient | null = null;
  let nodeId = "";
  let commandsToRun: string[] = [];
  const ctx: CommandContext = { notifications: [] };
  const results = new Map<string, CommandResult>();

  beforeAll(async () => {
    const { details, url, token, password } = resolveGatewayConnection();
    client = await connectGatewayClient({ password, token, url });

    const listRaw = await client.request("node.list", {});
    const nodes = parseNodeList(listRaw);
    expect(nodes.length, "node.list returned no nodes").toBeGreaterThan(0);

    const target = selectTargetNode(nodes);
    ({ nodeId } = target);

    if (!target.connected || !target.paired) {
      const pairingRaw = await client.request("node.pair.list", {});
      const pairing = parsePairingList(pairingRaw);
      const pendingForNode = pairing.pending.filter((entry) => entry.nodeId === nodeId);
      const pendingHint =
        pendingForNode.length > 0
          ? `pending request(s): ${pendingForNode.map((entry) => entry.requestId).join(", ")}`
          : "no pending request for selected node";
      throw new Error(
        [
          `selected node is not ready (nodeId=${nodeId}, connected=${String(target.connected)}, paired=${String(target.paired)})`,
          pendingHint,
          "precondition: open app, keep foreground, ensure pairing approved (`openclaw nodes pending` / `openclaw nodes approve <requestId>`)",
        ].join("\n"),
      );
    }

    const describeRaw = await client.request("node.describe", { nodeId });
    const describeObj = asRecord(describeRaw);
    const commands = readStringArray(describeObj.commands);
    expect(commands.length, "node.describe advertised no commands").toBeGreaterThan(0);

    const cfg = await resolvePolicyConfigForRun({
      client,
      connectionDetails: details,
    });
    const allowlist = resolveNodeCommandAllowlist(cfg, {
      deviceFamily: target.deviceFamily,
      platform: target.platform,
    });

    commandsToRun = commands.filter(
      (command) => allowlist.has(command) && !SKIPPED_INTERACTIVE_COMMANDS.has(command),
    );
    expect(
      commandsToRun.length,
      "node.describe advertised no non-interactive allowlisted commands (check gateway.nodes allowCommands/denyCommands)",
    ).toBeGreaterThan(0);

    const missingProfiles = commandsToRun.filter((command) => !COMMAND_PROFILES[command]);
    if (missingProfiles.length > 0) {
      throw new Error(
        `unmapped advertised commands: ${missingProfiles.join(", ")} (update COMMAND_PROFILES before running this suite)`,
      );
    }
  }, 60_000);

  afterAll(() => {
    client?.stop();
    client = null;
  });

  const profiledCommands = Object.keys(COMMAND_PROFILES).toSorted();
  for (const command of profiledCommands) {
    const profile = COMMAND_PROFILES[command];
    const timeout = Math.max(20_000, profile.timeoutMs ?? 20_000) + 15_000;
    it(`command: ${command}`, { timeout }, async () => {
      if (!client) {
        throw new Error("gateway client not connected");
      }
      if (!commandsToRun.includes(command)) {
        return;
      }
      const result = await invokeNodeCommand({ client, command, ctx, nodeId, profile });
      results.set(command, result);
      const issue = evaluateCommandResult({ ctx, profile, result });
      if (!issue) {
        return;
      }
      const status = result.ok ? "ok" : `err:${result.errorCode ?? "UNKNOWN"}`;
      throw new Error(
        [
          `${command}: ${issue}`,
          "summary:",
          `${result.command} -> ${status} (${result.durationMs}ms)`,
        ].join("\n"),
      );
    });
  }

  it("covers every advertised non-interactive command", () => {
    const missingRuns = commandsToRun.filter((command) => !results.has(command));
    if (missingRuns.length === 0) {
      return;
    }
    const summary = [...results.values()]
      .map((entry) => {
        const status = entry.ok ? "ok" : `err:${entry.errorCode ?? "UNKNOWN"}`;
        return `${entry.command} -> ${status} (${entry.durationMs}ms)`;
      })
      .join("\n");
    throw new Error(
      [
        `advertised commands missing execution (${missingRuns.length}/${commandsToRun.length})`,
        ...missingRuns,
        "summary:",
        summary,
      ].join("\n"),
    );
  });
});
