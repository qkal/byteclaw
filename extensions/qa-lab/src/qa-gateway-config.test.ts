import { describe, expect, it } from "vitest";
import {
  DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
  buildQaGatewayConfig,
  mergeQaControlUiAllowedOrigins,
} from "./qa-gateway-config.js";

function getPrimaryModel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "primary" in value) {
    const { primary } = value as { primary?: unknown };
    return typeof primary === "string" ? primary : undefined;
  }
  return undefined;
}

describe("buildQaGatewayConfig", () => {
  it("keeps mock-openai as the default provider lane", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18_789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.4");
    expect(cfg.models?.providers?.["mock-openai"]?.baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-channel"]);
    expect(cfg.plugins?.entries?.["memory-core"]).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toBeUndefined();
    expect(cfg.gateway?.reload?.deferralTimeoutMs).toBe(1000);
  });

  it("uses built-in provider wiring in frontier live mode", () => {
    const cfg = buildQaGatewayConfig({
      alternateModel: "openai/gpt-5.4",
      bind: "loopback",
      fastMode: true,
      gatewayPort: 18_789,
      gatewayToken: "token",
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.4");
    expect(getPrimaryModel(cfg.agents?.list?.[0]?.model)).toBe("openai/gpt-5.4");
    expect(cfg.models).toBeUndefined();
    expect(cfg.plugins?.allow).toEqual(["memory-core", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
      params: { fastMode: true, openaiWsWarmup: false, transport: "sse" },
    });
  });

  it("does not force OpenAI when the frontier lane only needs Anthropic and Google", () => {
    const cfg = buildQaGatewayConfig({
      alternateModel: "google/gemini-pro-test",
      bind: "loopback",
      gatewayPort: 18_789,
      gatewayToken: "token",
      imageGenerationModel: null,
      primaryModel: "anthropic/claude-sonnet-4-6",
      providerMode: "live-frontier",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(cfg.plugins?.allow).toEqual(["memory-core", "anthropic", "google", "qa-channel"]);
    expect(cfg.plugins?.entries?.anthropic).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.google).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toBeUndefined();
    expect(cfg.agents?.defaults).not.toHaveProperty("imageGenerationModel");
  });

  it("uses owning plugin ids separately from live model provider ids", () => {
    const cfg = buildQaGatewayConfig({
      alternateModel: "codex-cli/test-model",
      bind: "loopback",
      enabledPluginIds: ["openai"],
      gatewayPort: 18_789,
      gatewayToken: "token",
      imageGenerationModel: null,
      primaryModel: "codex-cli/test-model",
      providerMode: "live-frontier",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("codex-cli/test-model");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.["codex-cli"]).toBeUndefined();
  });

  it("merges selected live provider configs into the isolated QA config", () => {
    const cfg = buildQaGatewayConfig({
      alternateModel: "custom-openai/model-a",
      bind: "loopback",
      enabledPluginIds: ["openai"],
      gatewayPort: 18_789,
      gatewayToken: "token",
      imageGenerationModel: null,
      liveProviderConfigs: {
        "custom-openai": {
          api: "openai-responses",
          apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          baseUrl: "https://api.example.test/v1",
          models: [
            {
              api: "openai-responses",
              contextWindow: 128_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "model-a",
              input: ["text"],
              maxTokens: 4096,
              name: "model-a",
              reasoning: true,
            },
          ],
        },
      },
      primaryModel: "custom-openai/model-a",
      providerMode: "live-frontier",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(cfg.models?.mode).toBe("merge");
    expect(cfg.models?.providers?.["custom-openai"]?.api).toBe("openai-responses");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "openai", "qa-channel"]);
  });

  it("can set a QA default thinking level for judge turns", () => {
    const cfg = buildQaGatewayConfig({
      alternateModel: "openai/gpt-5.4",
      bind: "loopback",
      gatewayPort: 18_789,
      gatewayToken: "token",
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      thinkingDefault: "xhigh",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(cfg.agents?.defaults?.thinkingDefault).toBe("xhigh");
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.params).toMatchObject({
      thinking: "xhigh",
    });
  });

  it("can disable control ui for suite-only gateway children", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      controlUiEnabled: false,
      gatewayPort: 18_789,
      gatewayToken: "token",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(false);
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowInsecureAuth");
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowedOrigins");
  });

  it("pins control ui to a provided built root when available", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      controlUiRoot: "/tmp/openclaw/dist/control-ui",
      gatewayPort: 18_789,
      gatewayToken: "token",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(true);
    expect(cfg.gateway?.controlUi?.root).toBe("/tmp/openclaw/dist/control-ui");
  });

  it("merges dynamic qa-lab origins without dropping the built control ui root", () => {
    expect(mergeQaControlUiAllowedOrigins(["http://127.0.0.1:60196", "  "])).toEqual([
      ...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
      "http://127.0.0.1:60196",
    ]);

    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      controlUiAllowedOrigins: ["http://127.0.0.1:60196"],
      controlUiRoot: "/tmp/openclaw/dist/control-ui",
      gatewayPort: 18_789,
      gatewayToken: "token",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(cfg.gateway?.controlUi?.root).toBe("/tmp/openclaw/dist/control-ui");
    expect(cfg.gateway?.controlUi?.allowedOrigins).toEqual([
      ...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
      "http://127.0.0.1:60196",
    ]);
  });
});
