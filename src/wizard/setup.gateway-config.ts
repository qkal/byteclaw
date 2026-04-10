import {
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "../commands/onboard-helpers.js";
import type { GatewayAuthChoice, SecretInputMode } from "../commands/onboard-types.js";
import type { GatewayBindMode, GatewayTailscaleMode, OpenClawConfig } from "../config/config.js";
import { ensureControlUiAllowedOriginsForNonLoopbackBind } from "../config/gateway-control-ui-origins.js";
import {
  type SecretInput,
  normalizeSecretInputString,
  resolveSecretInputRef,
} from "../config/types.secrets.js";
import {
  TAILSCALE_DOCS_LINES,
  TAILSCALE_EXPOSURE_OPTIONS,
  TAILSCALE_MISSING_BIN_NOTE_LINES,
  maybeAddTailnetOriginToControlUiAllowedOrigins,
} from "../gateway/gateway-config-prompts.shared.js";
import { DEFAULT_DANGEROUS_NODE_COMMANDS } from "../gateway/node-command-policy.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import { resolveSecretInputModeForEnvSelection } from "../plugins/provider-auth-mode.js";
import { promptSecretRefForSetup } from "../plugins/provider-auth-ref.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateIPv4AddressInput } from "../shared/net/ipv4.js";
import type { WizardPrompter } from "./prompts.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type {
  GatewayWizardSettings,
  QuickstartGatewayDefaults,
  WizardFlow,
} from "./setup.types.js";

interface ConfigureGatewayOptions {
  flow: WizardFlow;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  localPort: number;
  quickstartGateway: QuickstartGatewayDefaults;
  secretInputMode?: SecretInputMode;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}

interface ConfigureGatewayResult {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
}

export async function configureGatewayForSetup(
  opts: ConfigureGatewayOptions,
): Promise<ConfigureGatewayResult> {
  const { flow, localPort, quickstartGateway, prompter } = opts;
  let { nextConfig } = opts;

  const port =
    flow === "quickstart"
      ? quickstartGateway.port
      : Number.parseInt(
          String(
            await prompter.text({
              initialValue: String(localPort),
              message: "Gateway port",
              validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
            }),
          ),
          10,
        );

  let bind: GatewayWizardSettings["bind"] =
    flow === "quickstart"
      ? quickstartGateway.bind
      : await prompter.select<GatewayWizardSettings["bind"]>({
          message: "Gateway bind",
          options: [
            { label: "Loopback (127.0.0.1)", value: "loopback" },
            { label: "LAN (0.0.0.0)", value: "lan" },
            { label: "Tailnet (Tailscale IP)", value: "tailnet" },
            { label: "Auto (Loopback → LAN)", value: "auto" },
            { label: "Custom IP", value: "custom" },
          ],
        });

  let { customBindHost } = quickstartGateway;
  if (bind === "custom") {
    const needsPrompt = flow !== "quickstart" || !customBindHost;
    if (needsPrompt) {
      const input = await prompter.text({
        initialValue: customBindHost ?? "",
        message: "Custom IP address",
        placeholder: "192.168.1.100",
        validate: validateIPv4AddressInput,
      });
      customBindHost = typeof input === "string" ? input.trim() : undefined;
    }
  }

  let authMode =
    flow === "quickstart"
      ? quickstartGateway.authMode
      : ((await prompter.select({
          initialValue: "token",
          message: "Gateway auth",
          options: [
            {
              hint: "Recommended default (local + remote)",
              label: "Token",
              value: "token",
            },
            { label: "Password", value: "password" },
          ],
        })) as GatewayAuthChoice);

  const tailscaleMode: GatewayWizardSettings["tailscaleMode"] =
    flow === "quickstart"
      ? quickstartGateway.tailscaleMode
      : await prompter.select<GatewayWizardSettings["tailscaleMode"]>({
          message: "Tailscale exposure",
          options: [...TAILSCALE_EXPOSURE_OPTIONS],
        });

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  // Persist the path so getTailnetHostname can reuse it for origin injection.
  let tailscaleBin: string | null = null;
  if (tailscaleMode !== "off") {
    tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      await prompter.note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
    }
  }

  let tailscaleResetOnExit = flow === "quickstart" ? quickstartGateway.tailscaleResetOnExit : false;
  if (tailscaleMode !== "off" && flow !== "quickstart") {
    await prompter.note(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
    tailscaleResetOnExit = Boolean(
      await prompter.confirm({
        initialValue: false,
        message: "Reset Tailscale serve/funnel on exit?",
      }),
    );
  }

  // Safety + constraints:
  // - Tailscale wants bind=loopback so we never expose a non-loopback server + tailscale serve/funnel at once.
  // - Funnel requires password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    await prompter.note("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
    bind = "loopback";
    customBindHost = undefined;
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    await prompter.note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  let gatewayTokenInput: SecretInput | undefined;
  if (authMode === "token") {
    const quickstartTokenString = normalizeSecretInputString(quickstartGateway.token);
    const quickstartTokenRef = resolveSecretInputRef({
      defaults: nextConfig.secrets?.defaults,
      value: quickstartGateway.token,
    }).ref;
    const tokenMode =
      flow === "quickstart" && opts.secretInputMode !== "ref" // Pragma: allowlist secret
        ? quickstartTokenRef
          ? "ref"
          : "plaintext"
        : await resolveSecretInputModeForEnvSelection({
            copy: {
              modeMessage: "How do you want to provide the gateway token?",
              plaintextHint: "Default",
              plaintextLabel: "Generate/store plaintext token",
              refHint: "Store a reference instead of plaintext",
              refLabel: "Use SecretRef",
            },
            explicitMode: opts.secretInputMode,
            prompter,
          });
    if (tokenMode === "ref") {
      if (flow === "quickstart" && quickstartTokenRef) {
        gatewayTokenInput = quickstartTokenRef;
        gatewayToken = await resolveSetupSecretInputString({
          config: nextConfig,
          env: process.env,
          path: "gateway.auth.token",
          value: quickstartTokenRef,
        });
      } else {
        const resolved = await promptSecretRefForSetup({
          config: nextConfig,
          copy: {
            envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
            sourceMessage: "Where is this gateway token stored?",
          },
          preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
          prompter,
          provider: "gateway-auth-token",
        });
        gatewayTokenInput = resolved.ref;
        gatewayToken = resolved.resolvedValue;
      }
    } else if (flow === "quickstart") {
      gatewayToken =
        (quickstartTokenString ?? normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN)) ||
        randomToken();
      gatewayTokenInput = gatewayToken;
    } else {
      const tokenInput = await prompter.text({
        initialValue:
          quickstartTokenString ??
          normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN) ??
          "",
        message: "Gateway token (blank to generate)",
        placeholder: "Needed for multi-machine or non-loopback access",
      });
      gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
      gatewayTokenInput = gatewayToken;
    }
  }

  if (authMode === "password") {
    let password: SecretInput | undefined =
      flow === "quickstart" && quickstartGateway.password ? quickstartGateway.password : undefined;
    if (!password) {
      const selectedMode = await resolveSecretInputModeForEnvSelection({
        copy: {
          modeMessage: "How do you want to provide the gateway password?",
          plaintextHint: "Stores the password directly in OpenClaw config",
          plaintextLabel: "Enter password now",
        },
        explicitMode: opts.secretInputMode,
        prompter,
      });
      if (selectedMode === "ref") {
        const resolved = await promptSecretRefForSetup({
          config: nextConfig,
          copy: {
            envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD",
            sourceMessage: "Where is this gateway password stored?",
          },
          preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
          prompter,
          provider: "gateway-auth-password",
        });
        password = resolved.ref;
      } else {
        password = String(
          (await prompter.text({
            message: "Gateway password",
            validate: validateGatewayPasswordInput,
          })) ?? "",
        ).trim();
      }
    }
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password,
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayTokenInput,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind: bind as GatewayBindMode,
      ...(bind === "custom" && customBindHost ? { customBindHost } : {}),
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode as GatewayTailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  if (
    flow === "quickstart" &&
    bind === "loopback" &&
    nextConfig.gateway?.controlUi?.allowInsecureAuth === undefined
  ) {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        controlUi: {
          ...nextConfig.gateway?.controlUi,
          allowInsecureAuth: true,
        },
      },
    };
  }

  nextConfig = ensureControlUiAllowedOriginsForNonLoopbackBind(nextConfig, {
    requireControlUiEnabled: true,
  }).config;
  nextConfig = await maybeAddTailnetOriginToControlUiAllowedOrigins({
    config: nextConfig,
    tailscaleBin,
    tailscaleMode,
  });

  // If this is a new gateway setup (no existing gateway settings), start with a
  // Denylist for high-risk node commands. Users can arm these temporarily via
  // /phone arm ... (phone-control plugin).
  if (
    !quickstartGateway.hasExisting &&
    nextConfig.gateway?.nodes?.denyCommands === undefined &&
    nextConfig.gateway?.nodes?.allowCommands === undefined &&
    nextConfig.gateway?.nodes?.browser === undefined
  ) {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        nodes: {
          ...nextConfig.gateway?.nodes,
          denyCommands: [...DEFAULT_DANGEROUS_NODE_COMMANDS],
        },
      },
    };
  }

  return {
    nextConfig,
    settings: {
      authMode,
      bind: bind as GatewayBindMode,
      customBindHost: bind === "custom" ? customBindHost : undefined,
      gatewayToken,
      port,
      tailscaleMode: tailscaleMode as GatewayTailscaleMode,
      tailscaleResetOnExit,
    },
  };
}
