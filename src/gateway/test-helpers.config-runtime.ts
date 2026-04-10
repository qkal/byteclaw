import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { ReadConfigFileSnapshotForWriteResult } from "../config/io.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { AgentBinding } from "../config/types.agents.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";
import { testConfigRoot, testIsNixMode, testState } from "./test-helpers.runtime-state.js";

type GatewayConfigModule = typeof import("../config/config.js");

export function createGatewayConfigModuleMock(actual: GatewayConfigModule): GatewayConfigModule {
  const resolveConfigPath = () => path.join(testConfigRoot.value, "openclaw.json");

  const composeTestConfig = (baseConfig: Record<string, unknown>) => {
    const fileAgents =
      baseConfig.agents &&
      typeof baseConfig.agents === "object" &&
      !Array.isArray(baseConfig.agents)
        ? (baseConfig.agents as Record<string, unknown>)
        : {};
    const fileDefaults =
      fileAgents.defaults &&
      typeof fileAgents.defaults === "object" &&
      !Array.isArray(fileAgents.defaults)
        ? (fileAgents.defaults as Record<string, unknown>)
        : {};
    const defaults = {
      model: { primary: "anthropic/claude-opus-4-6" },
      workspace: path.join(os.tmpdir(), "openclaw-gateway-test"),
      ...fileDefaults,
      ...testState.agentConfig,
    };
    const agents = testState.agentsConfig
      ? { ...fileAgents, ...testState.agentsConfig, defaults }
      : { ...fileAgents, defaults };

    const fileBindings = Array.isArray(baseConfig.bindings)
      ? (baseConfig.bindings as AgentBinding[])
      : undefined;

    const fileChannels =
      baseConfig.channels &&
      typeof baseConfig.channels === "object" &&
      !Array.isArray(baseConfig.channels)
        ? ({ ...(baseConfig.channels as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const overrideChannels =
      testState.channelsConfig && typeof testState.channelsConfig === "object"
        ? { ...testState.channelsConfig }
        : {};
    const mergedChannels = { ...fileChannels, ...overrideChannels };
    if (testState.allowFrom !== undefined) {
      const existing =
        mergedChannels.whatsapp &&
        typeof mergedChannels.whatsapp === "object" &&
        !Array.isArray(mergedChannels.whatsapp)
          ? (mergedChannels.whatsapp as Record<string, unknown>)
          : {};
      mergedChannels.whatsapp = {
        ...existing,
        allowFrom: testState.allowFrom,
      };
    }
    const channels = Object.keys(mergedChannels).length > 0 ? mergedChannels : undefined;

    const fileSession =
      baseConfig.session &&
      typeof baseConfig.session === "object" &&
      !Array.isArray(baseConfig.session)
        ? (baseConfig.session as Record<string, unknown>)
        : {};
    const session: Record<string, unknown> = {
      ...fileSession,
      mainKey: fileSession.mainKey ?? "main",
    };
    if (typeof testState.sessionStorePath === "string") {
      session.store = testState.sessionStorePath;
    }
    if (testState.sessionConfig) {
      Object.assign(session, testState.sessionConfig);
    }

    const fileGateway =
      baseConfig.gateway &&
      typeof baseConfig.gateway === "object" &&
      !Array.isArray(baseConfig.gateway)
        ? ({ ...(baseConfig.gateway as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    if (testState.gatewayBind) {
      fileGateway.bind = testState.gatewayBind;
    }
    if (testState.gatewayAuth) {
      fileGateway.auth = testState.gatewayAuth;
    }
    if (testState.gatewayControlUi) {
      const fileControlUi =
        fileGateway.controlUi &&
        typeof fileGateway.controlUi === "object" &&
        !Array.isArray(fileGateway.controlUi)
          ? (fileGateway.controlUi as Record<string, unknown>)
          : {};
      fileGateway.controlUi = {
        ...fileControlUi,
        ...testState.gatewayControlUi,
      };
    }
    const gateway = Object.keys(fileGateway).length > 0 ? fileGateway : undefined;

    const fileCanvasHost =
      baseConfig.canvasHost &&
      typeof baseConfig.canvasHost === "object" &&
      !Array.isArray(baseConfig.canvasHost)
        ? ({ ...(baseConfig.canvasHost as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    if (typeof testState.canvasHostPort === "number") {
      fileCanvasHost.port = testState.canvasHostPort;
    }
    const canvasHost = Object.keys(fileCanvasHost).length > 0 ? fileCanvasHost : undefined;

    const hooks = testState.hooksConfig ?? baseConfig.hooks;

    const fileCron =
      baseConfig.cron && typeof baseConfig.cron === "object" && !Array.isArray(baseConfig.cron)
        ? ({ ...(baseConfig.cron as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    if (typeof testState.cronEnabled === "boolean") {
      fileCron.enabled = testState.cronEnabled;
    }
    if (typeof testState.cronStorePath === "string") {
      fileCron.store = testState.cronStorePath;
    }
    const cron = Object.keys(fileCron).length > 0 ? fileCron : undefined;

    return {
      ...baseConfig,
      agents,
      bindings: testState.bindingsConfig ?? fileBindings,
      canvasHost,
      channels,
      cron,
      gateway,
      hooks,
      session,
    } as OpenClawConfig;
  };

  const readConfigFileSnapshot = async (): Promise<ConfigFileSnapshot> => {
    if (testState.legacyIssues.length > 0) {
      const raw = JSON.stringify(testState.legacyParsed ?? {});
      return buildTestConfigSnapshot({
        config: composeTestConfig({}),
        exists: true,
        issues: testState.legacyIssues.map((issue) => ({
          message: issue.message,
          path: issue.path,
        })),
        legacyIssues: testState.legacyIssues,
        parsed: testState.legacyParsed ?? {},
        path: resolveConfigPath(),
        raw,
        valid: false,
      });
    }
    const configPath = resolveConfigPath();
    try {
      await fs.access(configPath);
    } catch {
      return buildTestConfigSnapshot({
        config: composeTestConfig({}),
        exists: false,
        issues: [],
        legacyIssues: [],
        parsed: {},
        path: configPath,
        raw: null,
        valid: true,
      });
    }
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return buildTestConfigSnapshot({
        config: composeTestConfig(parsed),
        exists: true,
        issues: [],
        legacyIssues: [],
        parsed,
        path: configPath,
        raw,
        valid: true,
      });
    } catch (error) {
      return buildTestConfigSnapshot({
        config: composeTestConfig({}),
        exists: true,
        issues: [{ path: "", message: `read failed: ${String(error)}` }],
        legacyIssues: [],
        parsed: {},
        path: configPath,
        raw: null,
        valid: false,
      });
    }
  };

  const writeConfigFile = vi.fn(async (cfg: Record<string, unknown>) => {
    const configPath = resolveConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const raw = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
    await fs.writeFile(configPath, raw, "utf8");
    actual.resetConfigRuntimeState();
  });

  const readConfigFileSnapshotForWrite =
    async (): Promise<ReadConfigFileSnapshotForWriteResult> => ({
      snapshot: await readConfigFileSnapshot(),
      writeOptions: {
        expectedConfigPath: resolveConfigPath(),
      },
    });

  const loadTestConfig = () => {
    const configPath = resolveConfigPath();
    let fileConfig: Record<string, unknown> = {};
    try {
      if (fsSync.existsSync(configPath)) {
        const raw = fsSync.readFileSync(configPath, "utf8");
        fileConfig = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      fileConfig = {};
    }
    return applyPluginAutoEnable({
      config: composeTestConfig(fileConfig),
      env: process.env,
    }).config;
  };

  const loadRuntimeAwareTestConfig = () => {
    const runtimeSnapshot = actual.getRuntimeConfigSnapshot();
    if (runtimeSnapshot) {
      return runtimeSnapshot;
    }
    const config = loadTestConfig();
    actual.setRuntimeConfigSnapshot(config);
    return config;
  };

  return {
    ...actual,
    get CONFIG_PATH() {
      return resolveConfigPath();
    },
    get STATE_DIR() {
      return path.dirname(resolveConfigPath());
    },
    applyConfigOverrides: (cfg: OpenClawConfig) =>
      composeTestConfig(cfg as Record<string, unknown>),
    getRuntimeConfig: loadRuntimeAwareTestConfig,
    get isNixMode() {
      return testIsNixMode.value;
    },
    loadConfig: loadRuntimeAwareTestConfig,
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) as unknown };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    readConfigFileSnapshot,
    readConfigFileSnapshotForWrite,
    validateConfigObject: (parsed: unknown) => ({
      config: parsed as Record<string, unknown>,
      issues: [],
      ok: true,
    }),
    writeConfigFile,
  };
}
