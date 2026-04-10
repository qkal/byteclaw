import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import "../cron/isolated-agent.mocks.js";
import { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import { __testing as agentCommandTesting } from "../agents/agent-command.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import * as commandConfigResolutionModule from "../cli/command-config-resolution.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createDefaultAgentCommandResult,
  mockAgentCommandConfig,
  withAgentCommandTempHome,
} from "./agent-command.test-support.js";
import { agentCommand } from "./agent.js";

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: vi.fn(() => ({ profiles: {}, version: 1 })),
  };
});

vi.mock("../agents/command/session-store.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/command/session-store.js")>(
    "../agents/command/session-store.js",
  );
  return {
    ...actual,
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
  log: vi.fn(),
};

const configSpy = vi.spyOn(configModule, "loadConfig");
const readConfigFileSnapshotForWriteSpy = vi.spyOn(configModule, "readConfigFileSnapshotForWrite");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withAgentCommandTempHome("openclaw-agent-", fn);
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Parameters<typeof mockAgentCommandConfig>[3],
) {
  return mockAgentCommandConfig(configSpy, home, storePath, agentOverrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  resetAgentRunContextForTest();
  resetPluginRuntimeStateForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  configModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(createDefaultAgentCommandResult());
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  readConfigFileSnapshotForWriteSpy.mockResolvedValue({
    snapshot: { resolved: {} as OpenClawConfig, valid: false },
    writeOptions: {},
  } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
});

describe("agentCommand runtime config", () => {
  it("sets runtime snapshots from source config before embedded agent run", async () => {
    await withTempHome(async (home) => {
      const setRuntimeConfigSnapshotSpy = vi.spyOn(configModule, "setRuntimeConfigSnapshot");

      const store = path.join(home, "sessions.json");
      const loadedConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
            workspace: path.join(home, "openclaw"),
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" }, // Pragma: allowlist secret
              models: [],
            },
          },
        },
        session: { mainKey: "main", store },
      } as unknown as OpenClawConfig;
      const sourceConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" }, // Pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const resolvedConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-resolved-runtime", // Pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;

      configSpy.mockReturnValue(loadedConfig);
      readConfigFileSnapshotForWriteSpy.mockResolvedValue({
        snapshot: { resolved: sourceConfig, valid: true },
        writeOptions: {},
      } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
      const resolveConfigWithSecretsSpy = vi
        .spyOn(commandConfigResolutionModule, "resolveCommandConfigWithSecrets")
        .mockResolvedValueOnce({
          diagnostics: [],
          effectiveConfig: resolvedConfig,
          resolvedConfig,
        });

      const prepared = await agentCommandTesting.resolveAgentRuntimeConfig(runtime);

      expect(resolveConfigWithSecretsSpy).toHaveBeenCalledWith({
        commandName: "agent",
        config: loadedConfig,
        runtime,
        targetIds: expect.objectContaining({
          has: expect.any(Function),
        }),
      });
      const targetIds = resolveConfigWithSecretsSpy.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("models.providers.*.apiKey")).toBe(true);
      expect(targetIds.has("channels.telegram.botToken")).toBe(false);
      expect(setRuntimeConfigSnapshotSpy).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
      expect(prepared.cfg).toBe(resolvedConfig);
    });
  });

  it("includes channel secret targets when delivery is requested", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      const resolveConfigWithSecretsSpy = vi
        .spyOn(commandConfigResolutionModule, "resolveCommandConfigWithSecrets")
        .mockResolvedValueOnce({
          diagnostics: [],
          effectiveConfig: loadedConfig,
          resolvedConfig: loadedConfig,
        });

      await agentCommandTesting.resolveAgentRuntimeConfig(runtime, {
        runtimeTargetsChannelSecrets: true,
      });

      const targetIds = resolveConfigWithSecretsSpy.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("channels.telegram.botToken")).toBe(true);
    });
  });

  it("creates a session entry when deriving from --to", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hello", to: "+1555" }, runtime);

      const saved = JSON.parse(fs.readFileSync(store, "utf8")) as Record<
        string,
        { sessionId: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.sessionId).toBeTruthy();
    });
  });
});
