import * as dns from "node:dns";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  type PinnedDispatcherPolicy,
  createPinnedLookup,
  hasEnvHttpProxyConfigured,
  resolveFetch,
} from "openclaw/plugin-sdk/fetch-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";
import { getProxyUrlFromFetch } from "./proxy.js";

const log = createSubsystemLogger("telegram/network");

const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";
const TELEGRAM_FALLBACK_IPS: readonly string[] = ["149.154.167.220"];

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: unknown;
};

type TelegramDispatcher = Agent | EnvHttpProxyAgent | ProxyAgent;

type TelegramDispatcherMode = "direct" | "env-proxy" | "explicit-proxy";

interface TelegramDispatcherAttempt {
  dispatcherPolicy?: PinnedDispatcherPolicy;
}

interface TelegramTransportAttempt {
  createDispatcher: () => TelegramDispatcher;
  exportAttempt: TelegramDispatcherAttempt;
  logMessage?: string;
}

type TelegramDnsResultOrder = "ipv4first" | "verbatim";

type LookupCallback =
  | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void);

type LookupOptions = (dns.LookupOneOptions | dns.LookupAllOptions) & {
  order?: TelegramDnsResultOrder;
  verbatim?: boolean;
};

type LookupFunction = (
  hostname: string,
  options: number | dns.LookupOneOptions | dns.LookupAllOptions | undefined,
  callback: LookupCallback,
) => void;

const FALLBACK_RETRY_ERROR_CODES = [
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
] as const;

interface TelegramTransportFallbackContext {
  message: string;
  codes: Set<string>;
}

interface TelegramTransportFallbackRule {
  name: string;
  matches: (ctx: TelegramTransportFallbackContext) => boolean;
}

const TELEGRAM_TRANSPORT_FALLBACK_RULES: readonly TelegramTransportFallbackRule[] = [
  {
    matches: ({ message }) => message.includes("fetch failed"),
    name: "fetch-failed-envelope",
  },
  {
    matches: ({ codes }) => FALLBACK_RETRY_ERROR_CODES.some((code) => codes.has(code)),
    name: "known-network-code",
  },
];

function normalizeDnsResultOrder(value: string | null): TelegramDnsResultOrder | null {
  if (value === "ipv4first" || value === "verbatim") {
    return value;
  }
  return null;
}

function createDnsResultOrderLookup(
  order: TelegramDnsResultOrder | null,
): LookupFunction | undefined {
  if (!order) {
    return undefined;
  }
  const lookup = dns.lookup as unknown as (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ) => void;
  return (hostname, options, callback) => {
    const baseOptions: LookupOptions =
      typeof options === "number"
        ? { family: options }
        : (options
          ? { ...(options as LookupOptions) }
          : {});
    const lookupOptions: LookupOptions = {
      ...baseOptions,
      order,
      verbatim: order === "verbatim",
    };
    lookup(hostname, lookupOptions, callback);
  };
}

function buildTelegramConnectOptions(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  forceIpv4: boolean;
}): {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  family?: number;
  lookup?: LookupFunction;
} | null {
  const connect: {
    autoSelectFamily?: boolean;
    autoSelectFamilyAttemptTimeout?: number;
    family?: number;
    lookup?: LookupFunction;
  } = {};

  if (params.forceIpv4) {
    connect.family = 4;
    connect.autoSelectFamily = false;
  } else if (typeof params.autoSelectFamily === "boolean") {
    connect.autoSelectFamily = params.autoSelectFamily;
    connect.autoSelectFamilyAttemptTimeout = TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS;
  }

  const lookup = createDnsResultOrderLookup(params.dnsResultOrder);
  if (lookup) {
    connect.lookup = lookup;
  }

  return Object.keys(connect).length > 0 ? connect : null;
}

function shouldBypassEnvProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  const noProxyValue = env.no_proxy ?? env.NO_PROXY ?? "";
  if (!noProxyValue) {
    return false;
  }
  if (noProxyValue === "*") {
    return true;
  }
  const targetHostname = normalizeLowercaseStringOrEmpty(TELEGRAM_API_HOSTNAME);
  const targetPort = 443;
  const noProxyEntries = noProxyValue.split(/[,\s]/);
  for (let i = 0; i < noProxyEntries.length; i++) {
    const entry = noProxyEntries[i];
    if (!entry) {
      continue;
    }
    const parsed = entry.match(/^(.+):(\d+)$/);
    const entryHostname = normalizeLowercaseStringOrEmpty(
      (parsed ? parsed[1] : entry).replace(/^\*?\./, ""),
    );
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== targetPort) {
      continue;
    }
    if (
      targetHostname === entryHostname ||
      targetHostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`
    ) {
      return true;
    }
  }
  return false;
}

function hasEnvHttpProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasEnvHttpProxyConfigured("https", env);
}

function resolveTelegramDispatcherPolicy(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  useEnvProxy: boolean;
  forceIpv4: boolean;
  proxyUrl?: string;
}): { policy: PinnedDispatcherPolicy; mode: TelegramDispatcherMode } {
  const connect = buildTelegramConnectOptions({
    autoSelectFamily: params.autoSelectFamily,
    dnsResultOrder: params.dnsResultOrder,
    forceIpv4: params.forceIpv4,
  });
  const explicitProxyUrl = params.proxyUrl?.trim();
  if (explicitProxyUrl) {
    return {
      mode: "explicit-proxy",
      policy: connect
        ? {
            allowPrivateProxy: true,
            mode: "explicit-proxy",
            proxyTls: { ...connect },
            proxyUrl: explicitProxyUrl,
          }
        : {
            allowPrivateProxy: true,
            mode: "explicit-proxy",
            proxyUrl: explicitProxyUrl,
          },
    };
  }
  if (params.useEnvProxy) {
    return {
      mode: "env-proxy",
      policy: {
        mode: "env-proxy",
        ...(connect ? { connect: { ...connect }, proxyTls: { ...connect } } : {}),
      },
    };
  }
  return {
    mode: "direct",
    policy: {
      mode: "direct",
      ...(connect ? { connect: { ...connect } } : {}),
    },
  };
}

function withPinnedLookup(
  options: Record<string, unknown> | undefined,
  pinnedHostname: PinnedDispatcherPolicy["pinnedHostname"],
): Record<string, unknown> | undefined {
  if (!pinnedHostname) {
    return options ? { ...options } : undefined;
  }
  const lookup = createPinnedLookup({
    addresses: [...pinnedHostname.addresses],
    fallback: dns.lookup,
    hostname: pinnedHostname.hostname,
  });
  return options ? { ...options, lookup } : { lookup };
}

function createTelegramDispatcher(policy: PinnedDispatcherPolicy): {
  dispatcher: TelegramDispatcher;
  mode: TelegramDispatcherMode;
  effectivePolicy: PinnedDispatcherPolicy;
} {
  if (policy.mode === "explicit-proxy") {
    const requestTlsOptions = withPinnedLookup(policy.proxyTls, policy.pinnedHostname);
    const proxyOptions = requestTlsOptions
      ? ({
          requestTls: requestTlsOptions,
          uri: policy.proxyUrl,
        } satisfies ConstructorParameters<typeof ProxyAgent>[0])
      : policy.proxyUrl;
    try {
      return {
        dispatcher: new ProxyAgent(proxyOptions),
        effectivePolicy: policy,
        mode: "explicit-proxy",
      };
    } catch (error) {
      const reason = formatErrorMessage(error);
      throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: error });
    }
  }

  if (policy.mode === "env-proxy") {
    const connectOptions = withPinnedLookup(policy.connect, policy.pinnedHostname);
    const proxyTlsOptions = withPinnedLookup(policy.proxyTls, policy.pinnedHostname);
    const proxyOptions =
      connectOptions || proxyTlsOptions
        ? ({
            ...(connectOptions ? { connect: connectOptions } : {}),
            ...(proxyTlsOptions ? { proxyTls: proxyTlsOptions } : {}),
          } satisfies ConstructorParameters<typeof EnvHttpProxyAgent>[0])
        : undefined;
    try {
      return {
        dispatcher: new EnvHttpProxyAgent(proxyOptions),
        effectivePolicy: policy,
        mode: "env-proxy",
      };
    } catch (error) {
      log.warn(
        `env proxy dispatcher init failed; falling back to direct dispatcher: ${formatErrorMessage(error)}`,
      );
      const directPolicy: PinnedDispatcherPolicy = {
        mode: "direct",
        ...(connectOptions ? { connect: connectOptions } : {}),
      };
      return {
        dispatcher: new Agent(
          directPolicy.connect
            ? ({ connect: directPolicy.connect } satisfies ConstructorParameters<typeof Agent>[0])
            : undefined,
        ),
        effectivePolicy: directPolicy,
        mode: "direct",
      };
    }
  }

  const connectOptions = withPinnedLookup(policy.connect, policy.pinnedHostname);
  return {
    dispatcher: new Agent(
      connectOptions
        ? ({
            connect: connectOptions,
          } satisfies ConstructorParameters<typeof Agent>[0])
        : undefined,
    ),
    effectivePolicy: policy,
    mode: "direct",
  };
}

function withDispatcherIfMissing(
  init: RequestInit | undefined,
  dispatcher: TelegramDispatcher,
): RequestInitWithDispatcher {
  const withDispatcher = init as RequestInitWithDispatcher | undefined;
  if (withDispatcher?.dispatcher) {
    return init ?? {};
  }
  return init ? { ...init, dispatcher } : { dispatcher };
}

function resolveWrappedFetch(fetchImpl: typeof fetch): typeof fetch {
  return resolveFetch(fetchImpl) ?? fetchImpl;
}

function logResolverNetworkDecisions(params: {
  autoSelectDecision: ReturnType<typeof resolveTelegramAutoSelectFamilyDecision>;
  dnsDecision: ReturnType<typeof resolveTelegramDnsResultOrderDecision>;
}): void {
  if (params.autoSelectDecision.value !== null) {
    const sourceLabel = params.autoSelectDecision.source
      ? ` (${params.autoSelectDecision.source})`
      : "";
    log.debug(`autoSelectFamily=${params.autoSelectDecision.value}${sourceLabel}`);
  }
  if (params.dnsDecision.value !== null) {
    const sourceLabel = params.dnsDecision.source ? ` (${params.dnsDecision.source})` : "";
    log.debug(`dnsResultOrder=${params.dnsDecision.value}${sourceLabel}`);
  }
}

function collectErrorCodes(err: unknown): Set<string> {
  const codes = new Set<string>();
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (typeof current === "object") {
      const {code} = (current as { code?: unknown });
      if (typeof code === "string" && code.trim()) {
        codes.add(code.trim().toUpperCase());
      }
      const {cause} = (current as { cause?: unknown });
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const {errors} = (current as { errors?: unknown });
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
    }
  }

  return codes;
}

function formatErrorCodes(err: unknown): string {
  const codes = [...collectErrorCodes(err)];
  return codes.length > 0 ? codes.join(",") : "none";
}

function shouldUseTelegramTransportFallback(err: unknown): boolean {
  const ctx: TelegramTransportFallbackContext = {
    codes: collectErrorCodes(err),
    message:
      err && typeof err === "object" && "message" in err
        ? normalizeLowercaseStringOrEmpty(String(err.message))
        : "",
  };
  for (const rule of TELEGRAM_TRANSPORT_FALLBACK_RULES) {
    if (!rule.matches(ctx)) {
      return false;
    }
  }
  return true;
}

export function shouldRetryTelegramTransportFallback(err: unknown): boolean {
  return shouldUseTelegramTransportFallback(err);
}

export interface TelegramTransport {
  fetch: typeof fetch;
  sourceFetch: typeof fetch;
  dispatcherAttempts?: TelegramDispatcherAttempt[];
}

function createTelegramTransportAttempts(params: {
  defaultDispatcher: ReturnType<typeof createTelegramDispatcher>;
  allowFallback: boolean;
  fallbackPolicy?: PinnedDispatcherPolicy;
}): TelegramTransportAttempt[] {
  const attempts: TelegramTransportAttempt[] = [
    {
      createDispatcher: () => params.defaultDispatcher.dispatcher,
      exportAttempt: { dispatcherPolicy: params.defaultDispatcher.effectivePolicy },
    },
  ];

  if (!params.allowFallback || !params.fallbackPolicy) {
    return attempts;
  }
  const {fallbackPolicy} = params;

  let ipv4Dispatcher: TelegramDispatcher | null = null;
  attempts.push({
    createDispatcher: () => {
      if (!ipv4Dispatcher) {
        ipv4Dispatcher = createTelegramDispatcher(fallbackPolicy).dispatcher;
      }
      return ipv4Dispatcher;
    },
    exportAttempt: { dispatcherPolicy: fallbackPolicy },
    logMessage: "fetch fallback: enabling sticky IPv4-only dispatcher",
  });

  if (TELEGRAM_FALLBACK_IPS.length === 0) {
    return attempts;
  }

  const fallbackIpPolicy: PinnedDispatcherPolicy = {
    ...fallbackPolicy,
    pinnedHostname: {
      addresses: [...TELEGRAM_FALLBACK_IPS],
      hostname: TELEGRAM_API_HOSTNAME,
    },
  };
  let fallbackIpDispatcher: TelegramDispatcher | null = null;
  attempts.push({
    createDispatcher: () => {
      if (!fallbackIpDispatcher) {
        fallbackIpDispatcher = createTelegramDispatcher(fallbackIpPolicy).dispatcher;
      }
      return fallbackIpDispatcher;
    },
    exportAttempt: { dispatcherPolicy: fallbackIpPolicy },
    logMessage: "fetch fallback: DNS-resolved IP unreachable; trying alternative Telegram API IP",
  });

  return attempts;
}

export function resolveTelegramTransport(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): TelegramTransport {
  const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({
    network: options?.network,
  });
  const dnsDecision = resolveTelegramDnsResultOrderDecision({
    network: options?.network,
  });
  logResolverNetworkDecisions({
    autoSelectDecision,
    dnsDecision,
  });

  const explicitProxyUrl = proxyFetch ? getProxyUrlFromFetch(proxyFetch) : undefined;
  const undiciSourceFetch = resolveWrappedFetch(undiciFetch as unknown as typeof fetch);
  const sourceFetch = explicitProxyUrl
    ? undiciSourceFetch
    : (proxyFetch
      ? resolveWrappedFetch(proxyFetch)
      : undiciSourceFetch);
  const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
  if (proxyFetch && !explicitProxyUrl) {
    return { fetch: sourceFetch, sourceFetch };
  }

  const useEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForTelegramApi();
  const defaultDispatcherResolution = resolveTelegramDispatcherPolicy({
    autoSelectFamily: autoSelectDecision.value,
    dnsResultOrder,
    forceIpv4: false,
    proxyUrl: explicitProxyUrl,
    useEnvProxy,
  });
  const defaultDispatcher = createTelegramDispatcher(defaultDispatcherResolution.policy);
  const shouldBypassEnvProxy = shouldBypassEnvProxyForTelegramApi();
  const allowStickyFallback =
    defaultDispatcher.mode === "direct" ||
    (defaultDispatcher.mode === "env-proxy" && shouldBypassEnvProxy);
  const fallbackDispatcherPolicy = allowStickyFallback
    ? resolveTelegramDispatcherPolicy({
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
        forceIpv4: true,
        proxyUrl: explicitProxyUrl,
        useEnvProxy: defaultDispatcher.mode === "env-proxy",
      }).policy
    : undefined;
  const transportAttempts = createTelegramTransportAttempts({
    allowFallback: allowStickyFallback,
    defaultDispatcher,
    fallbackPolicy: fallbackDispatcherPolicy,
  });

  let stickyAttemptIndex = 0;
  const resolvedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const callerProvidedDispatcher = Boolean(
      (init as RequestInitWithDispatcher | undefined)?.dispatcher,
    );
    const startIndex = Math.min(stickyAttemptIndex, transportAttempts.length - 1);
    let err: unknown;

    try {
      return await sourceFetch(
        input,
        withDispatcherIfMissing(init, transportAttempts[startIndex].createDispatcher()),
      );
    } catch (error) {
      err = error;
    }

    if (!shouldUseTelegramTransportFallback(err)) {
      throw err;
    }
    if (callerProvidedDispatcher) {
      return sourceFetch(input, init ?? {});
    }

    for (let nextIndex = startIndex + 1; nextIndex < transportAttempts.length; nextIndex += 1) {
      const nextAttempt = transportAttempts[nextIndex];
      if (nextAttempt.logMessage) {
        log.warn(`${nextAttempt.logMessage} (codes=${formatErrorCodes(err)})`);
      }
      try {
        const response = await sourceFetch(
          input,
          withDispatcherIfMissing(init, nextAttempt.createDispatcher()),
        );
        stickyAttemptIndex = nextIndex;
        return response;
      } catch (error) {
        err = error;
        if (!shouldUseTelegramTransportFallback(err)) {
          throw err;
        }
      }
    }

    throw err;
  }) as typeof fetch;

  return {
    dispatcherAttempts: transportAttempts.map((attempt) => attempt.exportAttempt),
    fetch: resolvedFetch,
    sourceFetch,
  };
}

export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch {
  return resolveTelegramTransport(proxyFetch, options).fetch;
}

/**
 * Resolve the Telegram Bot API base URL from an optional `apiRoot` config value.
 * Returns a trimmed URL without trailing slash, or the standard default.
 */
export function resolveTelegramApiBase(apiRoot?: string): string {
  const trimmed = apiRoot?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : `https://${TELEGRAM_API_HOSTNAME}`;
}
