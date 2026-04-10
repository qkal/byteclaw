import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { DEFAULT_DANGEROUS_NODE_COMMANDS } from "../gateway/node-command-policy.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  getTailnetHostname: vi.fn(),
  randomToken: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-helpers.js")>();
  return {
    ...actual,
    randomToken: mocks.randomToken,
  };
});

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
  getTailnetHostname: mocks.getTailnetHostname,
}));

import { configureGatewayForSetup } from "./setup.gateway-config.js";

describe("configureGatewayForSetup", () => {
  function createPrompter(params: { selectQueue: string[]; textQueue: (string | undefined)[] }) {
    const selectQueue = [...params.selectQueue];
    const textQueue = [...params.textQueue];
    const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
      const next = selectQueue.shift();
      if (next !== undefined) {
        return next;
      }
      return params.initialValue ?? params.options[0]?.value;
    }) as unknown as WizardPrompter["select"];

    return buildWizardPrompter({
      select,
      text: vi.fn(async () => textQueue.shift() as string),
    });
  }

  function createRuntime(): RuntimeEnv {
    return {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
  }

  function createQuickstartGateway(authMode: "token" | "password") {
    return {
      authMode,
      bind: "loopback" as const,
      customBindHost: undefined,
      hasExisting: false,
      password: undefined,
      port: 18_789,
      tailscaleMode: "off" as const,
      tailscaleResetOnExit: false,
      token: undefined,
    };
  }

  async function runGatewayConfig(params?: {
    flow?: "advanced" | "quickstart";
    bindChoice?: string;
    authChoice?: "token" | "password";
    tailscaleChoice?: "off" | "serve";
    textQueue?: (string | undefined)[];
    nextConfig?: Record<string, unknown>;
  }) {
    const authChoice = params?.authChoice ?? "token";
    const prompter = createPrompter({
      selectQueue: [params?.bindChoice ?? "loopback", authChoice, params?.tailscaleChoice ?? "off"],
      textQueue: params?.textQueue ?? ["18789", undefined],
    });
    const runtime = createRuntime();
    return configureGatewayForSetup({
      baseConfig: {},
      flow: params?.flow ?? "advanced",
      localPort: 18_789,
      nextConfig: params?.nextConfig ?? {},
      prompter,
      quickstartGateway: createQuickstartGateway(authChoice),
      runtime,
    });
  }

  it("generates a token when the prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const result = await runGatewayConfig();

    expect(result.settings.gatewayToken).toBe("generated-token");
    expect(result.nextConfig.gateway?.nodes?.denyCommands).toEqual(DEFAULT_DANGEROUS_NODE_COMMANDS);
  });

  it("prefers OPENCLAW_GATEWAY_TOKEN during quickstart token setup", async () => {
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-from-env";
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.randomToken.mockClear();

    try {
      const result = await runGatewayConfig({
        flow: "quickstart",
        textQueue: [],
      });

      expect(result.settings.gatewayToken).toBe("token-from-env");
    } finally {
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }
  });

  it("enables insecure local control ui auth for fresh quickstart loopback setups", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    const result = await runGatewayConfig({
      flow: "quickstart",
      textQueue: [],
    });

    expect(result.nextConfig.gateway?.controlUi?.allowInsecureAuth).toBe(true);
  });

  it("preserves explicit control ui auth policy in quickstart", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    const result = await runGatewayConfig({
      flow: "quickstart",
      nextConfig: {
        gateway: {
          controlUi: {
            allowInsecureAuth: false,
          },
        },
      },
      textQueue: [],
    });

    expect(result.nextConfig.gateway?.controlUi?.allowInsecureAuth).toBe(false);
  });

  it("enables insecure local control ui auth when quickstart reuses an existing loopback config", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const prompter = createPrompter({
      selectQueue: [],
      textQueue: [],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForSetup({
      baseConfig: {},
      flow: "quickstart",
      localPort: 18_789,
      nextConfig: {
        gateway: {
          bind: "loopback",
          port: 18_789,
        },
      },
      prompter,
      quickstartGateway: {
        ...createQuickstartGateway("token"),
        hasExisting: true,
      },
      runtime,
    });

    expect(result.nextConfig.gateway?.controlUi?.allowInsecureAuth).toBe(true);
  });

  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("unused");
    const result = await runGatewayConfig({
      authChoice: "password",
    });

    const authConfig = result.nextConfig.gateway?.auth as { mode?: string; password?: string };
    expect(authConfig?.mode).toBe("password");
    expect(authConfig?.password).toBe("");
    expect(authConfig?.password).not.toBe("undefined");
  });

  it("seeds control UI allowed origins for non-loopback binds", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const result = await runGatewayConfig({
      bindChoice: "lan",
    });

    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });

  it("honors secretInputMode=ref for gateway password prompts", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "gateway-secret"; // Pragma: allowlist secret
    try {
      const prompter = createPrompter({
        selectQueue: ["loopback", "password", "off", "env"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_PASSWORD"],
      });
      const runtime = createRuntime();

      const result = await configureGatewayForSetup({
        flow: "advanced",
        baseConfig: {},
        nextConfig: {},
        localPort: 18_789,
        quickstartGateway: createQuickstartGateway("password"),
        secretInputMode: "ref", // Pragma: allowlist secret
        prompter,
        runtime,
      });

      expect(result.nextConfig.gateway?.auth?.mode).toBe("password");
      expect(result.nextConfig.gateway?.auth?.password).toEqual({
        id: "OPENCLAW_GATEWAY_PASSWORD",
        provider: "default",
        source: "env",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }
  });

  it("stores gateway token as SecretRef when secretInputMode=ref", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-from-env";
    try {
      const prompter = createPrompter({
        selectQueue: ["loopback", "token", "off", "env"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_TOKEN"],
      });
      const runtime = createRuntime();

      const result = await configureGatewayForSetup({
        flow: "advanced",
        baseConfig: {},
        nextConfig: {},
        localPort: 18_789,
        quickstartGateway: createQuickstartGateway("token"),
        secretInputMode: "ref", // Pragma: allowlist secret
        prompter,
        runtime,
      });

      expect(result.nextConfig.gateway?.auth?.mode).toBe("token");
      expect(result.nextConfig.gateway?.auth?.token).toEqual({
        id: "OPENCLAW_GATEWAY_TOKEN",
        provider: "default",
        source: "env",
      });
      expect(result.settings.gatewayToken).toBe("token-from-env");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous;
      }
    }
  });

  it("resolves quickstart exec SecretRefs for gateway token bootstrap", async () => {
    const quickstartGateway = {
      ...createQuickstartGateway("token"),
      token: {
        id: "gateway/auth/token",
        provider: "gatewayTokens",
        source: "exec" as const,
      },
    };
    const runtime = createRuntime();
    const prompter = createPrompter({
      selectQueue: [],
      textQueue: [],
    });

    const result = await configureGatewayForSetup({
      baseConfig: {},
      flow: "quickstart",
      localPort: 18_789,
      nextConfig: {
        secrets: {
          providers: {
            gatewayTokens: {
              allowInsecurePath: true,
              allowSymlinkCommand: true,
              args: [
                "-e",
                "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const req=JSON.parse(input||'{}');const values={};for(const id of req.ids||[]){values[id]='token-from-exec';}process.stdout.write(JSON.stringify({protocolVersion:1,values}));});",
              ],
              command: process.execPath,
              source: "exec",
            },
          },
        },
      },
      prompter,
      quickstartGateway,
      runtime,
    });

    expect(result.nextConfig.gateway?.auth?.token).toEqual(quickstartGateway.token);
    expect(result.settings.gatewayToken).toBe("token-from-exec");
  });
});
