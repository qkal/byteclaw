import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { isSecureWebSocketUrl } from "../gateway/net.js";
import { type GatewayBonjourBeacon, discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import {
  buildGatewayDiscoveryLabel,
  buildGatewayDiscoveryTarget,
} from "../infra/gateway-discovery-targets.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import { resolveSecretInputModeForEnvSelection } from "../plugins/provider-auth-mode.js";
import { promptSecretRefForSetup } from "../plugins/provider-auth-ref.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";
import type { SecretInputMode } from "./onboard-types.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

function buildLabel(beacon: GatewayBonjourBeacon): string {
  return buildGatewayDiscoveryLabel(beacon);
}

function ensureWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_GATEWAY_URL;
  }
  return trimmed;
}

function validateGatewayWebSocketUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
    return "URL must start with ws:// or wss://";
  }
  if (
    !isSecureWebSocketUrl(trimmed, {
      allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1",
    })
  ) {
    return (
      "Use wss:// for remote hosts, or ws://127.0.0.1/localhost via SSH tunnel. " +
      "Break-glass: OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 for trusted private networks."
    );
  }
  return undefined;
}

export async function promptRemoteGatewayConfig(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { secretInputMode?: SecretInputMode },
): Promise<OpenClawConfig> {
  let selectedBeacon: GatewayBonjourBeacon | null = null;
  let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;
  let discoveryTlsFingerprint: string | undefined;
  let trustedDiscoveryUrl: string | undefined;

  const hasBonjourTool = (await detectBinary("dns-sd")) || (await detectBinary("avahi-browse"));
  const wantsDiscover = hasBonjourTool
    ? await prompter.confirm({
        initialValue: true,
        message: "Discover gateway on LAN (Bonjour)?",
      })
    : false;

  if (!hasBonjourTool) {
    await prompter.note(
      [
        "Bonjour discovery requires dns-sd (macOS) or avahi-browse (Linux).",
        "Docs: https://docs.openclaw.ai/gateway/discovery",
      ].join("\n"),
      "Discovery",
    );
  }

  if (wantsDiscover) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: cfg.discovery?.wideArea?.domain,
    });
    const spin = prompter.progress("Searching for gateways…");
    const beacons = await discoverGatewayBeacons({ timeoutMs: 2000, wideAreaDomain });
    spin.stop(beacons.length > 0 ? `Found ${beacons.length} gateway(s)` : "No gateways found");

    if (beacons.length > 0) {
      const selection = await prompter.select({
        message: "Select gateway",
        options: [
          ...beacons.map((beacon, index) => ({
            label: buildLabel(beacon),
            value: String(index),
          })),
          { label: "Enter URL manually", value: "manual" },
        ],
      });
      if (selection !== "manual") {
        const idx = Number.parseInt(String(selection), 10);
        selectedBeacon = Number.isFinite(idx) ? (beacons[idx] ?? null) : null;
      }
    }
  }

  if (selectedBeacon) {
    const target = buildGatewayDiscoveryTarget(selectedBeacon);
    if (target.endpoint) {
      const { host, port } = target.endpoint;
      const mode = await prompter.select({
        message: "Connection method",
        options: [
          {
            label: `Direct gateway WS (${host}:${port})`,
            value: "direct",
          },
          { label: "SSH tunnel (loopback)", value: "ssh" },
        ],
      });
      if (mode === "direct") {
        suggestedUrl = `wss://${host}:${port}`;
        const fingerprint = target.endpoint.gatewayTlsFingerprintSha256;
        const trusted = await prompter.confirm({
          initialValue: false,
          message: `Trust this gateway? Host: ${host}:${port} TLS fingerprint: ${fingerprint ?? "not advertised (connection will not be pinned)"}`,
        });
        if (trusted) {
          discoveryTlsFingerprint = fingerprint;
          trustedDiscoveryUrl = suggestedUrl;
          await prompter.note(
            [
              "Direct remote access defaults to TLS.",
              `Using: ${suggestedUrl}`,
              ...(fingerprint ? [`TLS pin: ${fingerprint}`] : []),
              "If your gateway is loopback-only, choose SSH tunnel and keep ws://127.0.0.1:18789.",
            ].join("\n"),
            "Direct remote",
          );
        } else {
          // Clear the discovered endpoint so the manual prompt falls back to a safe default.
          suggestedUrl = DEFAULT_GATEWAY_URL;
        }
      } else {
        suggestedUrl = DEFAULT_GATEWAY_URL;
        await prompter.note(
          [
            "Start a tunnel before using the CLI:",
            `ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${target.sshPort ? ` -p ${target.sshPort}` : ""}`,
            "Docs: https://docs.openclaw.ai/gateway/remote",
          ].join("\n"),
          "SSH tunnel",
        );
      }
    }
  }

  const urlInput = await prompter.text({
    initialValue: suggestedUrl,
    message: "Gateway WebSocket URL",
    validate: (value) => validateGatewayWebSocketUrl(String(value)),
  });
  const url = ensureWsUrl(String(urlInput));
  const pinnedDiscoveryFingerprint =
    discoveryTlsFingerprint && url === trustedDiscoveryUrl ? discoveryTlsFingerprint : undefined;

  const authChoice = await prompter.select({
    message: "Gateway auth",
    options: [
      { label: "Token (recommended)", value: "token" },
      { label: "Password", value: "password" },
      { label: "No auth", value: "off" },
    ],
  });

  let token: SecretInput | undefined = cfg.gateway?.remote?.token;
  let password: SecretInput | undefined = cfg.gateway?.remote?.password;
  if (authChoice === "token") {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      copy: {
        modeMessage: "How do you want to provide this gateway token?",
        plaintextHint: "Stores the token directly in OpenClaw config",
        plaintextLabel: "Enter token now",
      },
      explicitMode: options?.secretInputMode,
      prompter,
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForSetup({
        config: cfg,
        copy: {
          envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
          sourceMessage: "Where is this gateway token stored?",
        },
        preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
        prompter,
        provider: "gateway-remote-token",
      });
      token = resolved.ref;
    } else {
      token = String(
        await prompter.text({
          initialValue: typeof token === "string" ? token : undefined,
          message: "Gateway token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }
    password = undefined;
  } else if (authChoice === "password") {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      copy: {
        modeMessage: "How do you want to provide this gateway password?",
        plaintextHint: "Stores the password directly in OpenClaw config",
        plaintextLabel: "Enter password now",
      },
      explicitMode: options?.secretInputMode,
      prompter,
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForSetup({
        config: cfg,
        copy: {
          envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD",
          sourceMessage: "Where is this gateway password stored?",
        },
        preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
        prompter,
        provider: "gateway-remote-password",
      });
      password = resolved.ref;
    } else {
      password = String(
        await prompter.text({
          initialValue: typeof password === "string" ? password : undefined,
          message: "Gateway password",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }
    token = undefined;
  } else {
    token = undefined;
    password = undefined;
  }

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        url,
        ...(token !== undefined ? { token } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(pinnedDiscoveryFingerprint ? { tlsFingerprint: pinnedDiscoveryFingerprint } : {}),
      },
    },
  };
}
