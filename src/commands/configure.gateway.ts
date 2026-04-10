import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/config.js";
import { type SecretInput, isValidEnvSecretRefId } from "../config/types.secrets.js";
import {
  TAILSCALE_DOCS_LINES,
  TAILSCALE_EXPOSURE_OPTIONS,
  TAILSCALE_MISSING_BIN_NOTE_LINES,
  maybeAddTailnetOriginToControlUiAllowedOrigins,
} from "../gateway/gateway-config-prompts.shared.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { validateIPv4AddressInput } from "../shared/net/ipv4.js";
import { normalizeOptionalString, readStringValue } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { note } from "../terminal/note.js";
import { buildGatewayAuthConfig } from "./configure.gateway-auth.js";
import { confirm, select, text } from "./configure.shared.js";
import {
  guardCancel,
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "./onboard-helpers.js";

type GatewayAuthChoice = "token" | "password" | "trusted-proxy";
type GatewayTokenInputMode = "plaintext" | "ref";

export async function promptGatewayConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: OpenClawConfig;
  port: number;
  token?: string;
}> {
  const portRaw = guardCancel(
    await text({
      initialValue: String(resolveGatewayPort(cfg)),
      message: "Gateway port",
      validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
    }),
    runtime,
  );
  const port = Number.parseInt(String(portRaw), 10);

  let bind = guardCancel(
    await select({
      message: "Gateway bind mode",
      options: [
        {
          hint: "Bind to 127.0.0.1 - secure, local-only access",
          label: "Loopback (Local only)",
          value: "loopback",
        },
        {
          hint: "Bind to your Tailscale IP only (100.x.x.x)",
          label: "Tailnet (Tailscale IP)",
          value: "tailnet",
        },
        {
          hint: "Prefer loopback; fall back to all interfaces if unavailable",
          label: "Auto (Loopback → LAN)",
          value: "auto",
        },
        {
          hint: "Bind to 0.0.0.0 - accessible from anywhere on your network",
          label: "LAN (All interfaces)",
          value: "lan",
        },
        {
          hint: "Specify a specific IP address, with 0.0.0.0 fallback if unavailable",
          label: "Custom IP",
          value: "custom",
        },
      ],
    }),
    runtime,
  );

  let customBindHost: string | undefined;
  if (bind === "custom") {
    const input = guardCancel(
      await text({
        message: "Custom IP address",
        placeholder: "192.168.1.100",
        validate: validateIPv4AddressInput,
      }),
      runtime,
    );
    customBindHost = readStringValue(input);
  }

  let authMode = guardCancel(
    await select({
      initialValue: "token",
      message: "Gateway auth",
      options: [
        { hint: "Recommended default", label: "Token", value: "token" },
        { label: "Password", value: "password" },
        {
          hint: "Behind reverse proxy (Pomerium, Caddy, Traefik, etc.)",
          label: "Trusted Proxy",
          value: "trusted-proxy",
        },
      ],
    }),
    runtime,
  ) as GatewayAuthChoice;

  let tailscaleMode = guardCancel(
    await select({
      message: "Tailscale exposure",
      options: [...TAILSCALE_EXPOSURE_OPTIONS],
    }),
    runtime,
  );

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  // Persist the path so getTailnetHostname can reuse it for origin injection.
  let tailscaleBin: string | null = null;
  if (tailscaleMode !== "off") {
    tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
    }
  }

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    note(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
    tailscaleResetOnExit = Boolean(
      guardCancel(
        await confirm({
          initialValue: false,
          message: "Reset Tailscale serve/funnel on exit?",
        }),
        runtime,
      ),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
    bind = "loopback";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  // Trusted-proxy + loopback is valid when the reverse proxy runs on the same
  // Host (e.g. cloudflared, nginx, Caddy). trustedProxies must include 127.0.0.1.
  if (authMode === "trusted-proxy" && tailscaleMode !== "off") {
    note(
      "Trusted proxy auth is incompatible with Tailscale serve/funnel. Disabling Tailscale.",
      "Note",
    );
    tailscaleMode = "off";
    tailscaleResetOnExit = false;
  }

  let gatewayToken: SecretInput | undefined;
  let gatewayTokenForCalls: string | undefined;
  let gatewayPassword: string | undefined;
  let trustedProxyConfig:
    | { userHeader: string; requiredHeaders?: string[]; allowUsers?: string[] }
    | undefined;
  let trustedProxies: string[] | undefined;
  let next = cfg;

  if (authMode === "token") {
    const tokenInputMode = guardCancel(
      await select<GatewayTokenInputMode>({
        initialValue: "plaintext",
        message: "Gateway token source",
        options: [
          {
            hint: "Default",
            label: "Generate/store plaintext token",
            value: "plaintext",
          },
          {
            hint: "Store an env-backed reference instead of plaintext",
            label: "Use SecretRef",
            value: "ref",
          },
        ],
      }),
      runtime,
    );
    if (tokenInputMode === "ref") {
      const envVar = guardCancel(
        await text({
          initialValue: "OPENCLAW_GATEWAY_TOKEN",
          message: "Gateway token env var",
          placeholder: "OPENCLAW_GATEWAY_TOKEN",
          validate: (value) => {
            const candidate = normalizeOptionalString(value) ?? "";
            if (!isValidEnvSecretRefId(candidate)) {
              return "Use an env var name like OPENCLAW_GATEWAY_TOKEN.";
            }
            const resolved = process.env[candidate]?.trim();
            if (!resolved) {
              return `Environment variable "${candidate}" is missing or empty in this session.`;
            }
            return undefined;
          },
        }),
        runtime,
      );
      const envVarName = normalizeOptionalString(envVar) ?? "";
      gatewayToken = {
        id: envVarName,
        provider: resolveDefaultSecretProviderAlias(cfg, "env", {
          preferFirstProviderForSource: true,
        }),
        source: "env",
      };
      note(`Validated ${envVarName}. OpenClaw will store a token SecretRef.`, "Gateway token");
    } else {
      const tokenInput = guardCancel(
        await text({
          initialValue: randomToken(),
          message: "Gateway token (blank to generate)",
        }),
        runtime,
      );
      gatewayTokenForCalls = normalizeGatewayTokenInput(tokenInput) || randomToken();
      gatewayToken = gatewayTokenForCalls;
    }
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "Gateway password",
        validate: validateGatewayPasswordInput,
      }),
      runtime,
    );
    gatewayPassword = normalizeOptionalString(password) ?? "";
  }

  if (authMode === "trusted-proxy") {
    note(
      [
        "Trusted proxy mode: OpenClaw trusts user identity from a reverse proxy.",
        "The proxy must authenticate users and pass identity via headers.",
        "Only requests from specified proxy IPs will be trusted.",
        "",
        "Common use cases: Pomerium, Caddy + OAuth, Traefik + forward auth",
        "Docs: https://docs.openclaw.ai/gateway/trusted-proxy-auth",
      ].join("\n"),
      "Trusted Proxy Auth",
    );

    const userHeader = guardCancel(
      await text({
        initialValue: "x-forwarded-user",
        message: "Header containing user identity",
        placeholder: "x-forwarded-user",
        validate: (value) => (value?.trim() ? undefined : "User header is required"),
      }),
      runtime,
    );

    const requiredHeadersRaw = guardCancel(
      await text({
        message: "Required headers (comma-separated, optional)",
        placeholder: "x-forwarded-proto,x-forwarded-host",
      }),
      runtime,
    );
    const requiredHeaders = requiredHeadersRaw
      ? normalizeStringEntries(String(requiredHeadersRaw).split(","))
      : [];

    const allowUsersRaw = guardCancel(
      await text({
        message: "Allowed users (comma-separated, blank = all authenticated users)",
        placeholder: "nick@example.com,admin@company.com",
      }),
      runtime,
    );
    const allowUsers = allowUsersRaw
      ? normalizeStringEntries(String(allowUsersRaw).split(","))
      : [];

    const trustedProxiesRaw = guardCancel(
      await text({
        message: "Trusted proxy IPs (comma-separated)",
        placeholder: "10.0.1.10,192.168.1.5",
        validate: (value) => {
          if (!normalizeOptionalString(value)) {
            return "At least one trusted proxy IP is required";
          }
          return undefined;
        },
      }),
      runtime,
    );
    trustedProxies = normalizeStringEntries(String(trustedProxiesRaw).split(","));

    trustedProxyConfig = {
      allowUsers: allowUsers.length > 0 ? allowUsers : undefined,
      requiredHeaders: requiredHeaders.length > 0 ? requiredHeaders : undefined,
      userHeader: normalizeOptionalString(userHeader) ?? "",
    };
  }

  const authConfig = buildGatewayAuthConfig({
    existing: next.gateway?.auth,
    mode: authMode,
    password: gatewayPassword,
    token: gatewayToken,
    trustedProxy: trustedProxyConfig,
  });

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      port,
      bind,
      auth: authConfig,
      ...(customBindHost && { customBindHost }),
      ...(trustedProxies && { trustedProxies }),
      tailscale: {
        ...next.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  next = await maybeAddTailnetOriginToControlUiAllowedOrigins({
    config: next,
    tailscaleBin,
    tailscaleMode,
  });

  return { config: next, port, token: gatewayTokenForCalls };
}
