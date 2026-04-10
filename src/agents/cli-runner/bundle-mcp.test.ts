import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  writeClaudeBundleManifest,
} from "../../plugins/bundle-mcp.test-support.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

describe("prepareCliBundleMcpConfig", () => {
  it("injects a strict empty --mcp-config overlay for bundle-MCP-enabled backends without servers", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-empty-");

    const prepared = await prepareCliBundleMcpConfig({
      backend: {
        args: ["./fake-claude.mjs"],
        command: "node",
      },
      config: {},
      enabled: true,
      mode: "claude-config-file",
      workspaceDir,
    });

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    expect(typeof generatedConfigPath).toBe("string");
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toEqual({});

    await prepared.cleanup?.();
  });

  it("injects a merged --mcp-config overlay for bundle-MCP-enabled backends", async () => {
    const env = captureEnv(["HOME"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDir;

      const { serverPath } = await createBundleProbePlugin(homeDir);

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const prepared = await prepareCliBundleMcpConfig({
        backend: {
          args: ["./fake-claude.mjs"],
          command: "node",
        },
        config,
        enabled: true,
        mode: "claude-config-file",
        workspaceDir,
      });

      const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
      expect(configFlagIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.backend.args).toContain("--strict-mcp-config");
      const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
      expect(typeof generatedConfigPath).toBe("string");
      const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf8")) as {
        mcpServers?: Record<string, { args?: string[] }>;
      };
      expect(raw.mcpServers?.bundleProbe?.args).toEqual([await fs.realpath(serverPath)]);
      expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);

      await prepared.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("loads workspace bundle MCP plugins from the configured workspace root", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-root-");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "workspace-probe");
    const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
    await fs.mkdir(path.dirname(serverPath), { recursive: true });
    await fs.writeFile(serverPath, "export {};\n", "utf8");
    await writeClaudeBundleManifest({
      homeDir: workspaceDir,
      manifest: { name: "workspace-probe" },
      pluginId: "workspace-probe",
    });
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            workspaceProbe: {
              args: ["./servers/probe.mjs"],
              command: "node",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      backend: {
        args: ["./fake-claude.mjs"],
        command: "node",
      },
      config: {
        plugins: {
          entries: {
            "workspace-probe": { enabled: true },
          },
        },
      },
      enabled: true,
      mode: "claude-config-file",
      workspaceDir,
    });

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.workspaceProbe?.args).toEqual([await fs.realpath(serverPath)]);

    await prepared.cleanup?.();
  });

  it("merges loopback overlay config with bundle MCP servers", async () => {
    const env = captureEnv(["HOME"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDir;

      await createBundleProbePlugin(homeDir);

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const prepared = await prepareCliBundleMcpConfig({
        additionalConfig: {
          mcpServers: {
            openclaw: {
              headers: {
                Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              },
              type: "http",
              url: "http://127.0.0.1:23119/mcp",
            },
          },
        },
        backend: {
          args: ["./fake-claude.mjs"],
          command: "node",
        },
        config,
        enabled: true,
        mode: "claude-config-file",
        workspaceDir,
      });

      const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
      const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
      const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf8")) as {
        mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
      };
      expect(Object.keys(raw.mcpServers ?? {}).toSorted()).toEqual(["bundleProbe", "openclaw"]);
      expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
      expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer ${OPENCLAW_MCP_TOKEN}");

      await prepared.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("preserves extra env values alongside generated MCP config", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-env-");

    const prepared = await prepareCliBundleMcpConfig({
      backend: {
        args: ["./fake-claude.mjs"],
        command: "node",
      },
      config: {},
      enabled: true,
      env: {
        OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
      },
      mode: "claude-config-file",
      workspaceDir,
    });

    expect(prepared.env).toEqual({
      OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
      OPENCLAW_MCP_TOKEN: "loopback-token-123",
    });

    await prepared.cleanup?.();
  });

  it("leaves args untouched when bundle MCP is disabled", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      backend: {
        args: ["./fake-cli.mjs"],
        command: "node",
      },
      enabled: false,
      workspaceDir: "/tmp/openclaw-bundle-mcp-disabled",
    });

    expect(prepared.backend.args).toEqual(["./fake-cli.mjs"]);
    expect(prepared.cleanup).toBeUndefined();
  });

  it("injects codex MCP config overrides with env-backed loopback headers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
            },
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
          },
        },
      },
      backend: {
        args: ["exec", "--json"],
        command: "codex",
        resumeArgs: ["exec", "resume", "{sessionId}"],
      },
      enabled: true,
      mode: "codex-config-overrides",
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex",
    });

    expect(prepared.backend.args).toEqual([
      "exec",
      "--json",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.backend.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.cleanup).toBeUndefined();
  });

  it("writes Gemini system settings for bundle MCP servers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
          },
        },
      },
      backend: {
        args: ["--prompt", "{prompt}"],
        command: "gemini",
      },
      enabled: true,
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
      },
      mode: "gemini-system-settings",
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
    });

    expect(prepared.backend.args).toEqual(["--prompt", "{prompt}"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("loopback-token-123");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf8"),
    ) as {
      mcp?: { allowed?: string[] };
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(raw.mcp?.allowed).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer loopback-token-123");

    await prepared.cleanup?.();
  });
});
