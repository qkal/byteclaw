import { createHash } from "node:crypto";
import {
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import { CANVAS_WS_PATH, handleA2uiHttpRequest } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { listBundledChannelPlugins } from "../channels/plugins/bundled.js";
import { loadConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveHookExternalContentSource as resolveHookExternalContentSourceFromSession } from "../security/external-content.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  type AuthRateLimiter,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
} from "./auth-rate-limit.js";
import {
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
} from "./auth.js";
import { normalizeCanvasScopedUrl } from "./canvas-capability.js";
import {
  type ControlUiRootState,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { handleOpenAiEmbeddingsHttpRequest } from "./embeddings-http.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  getHookSessionKeyPrefixError,
  isHookAgentAllowed,
  isSessionKeyAllowedByPrefix,
  normalizeAgentPayload,
  normalizeHookDispatchSessionKey,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookChannel,
  resolveHookDeliver,
  resolveHookIdempotencyKey,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
} from "./hooks.js";
import { sendGatewayAuthFailure, setDefaultSecurityHeaders } from "./http-common.js";
import {
  type AuthorizedGatewayHttpRequest,
  authorizeGatewayHttpRequestOrReply,
  getBearerToken,
  resolveHttpBrowserOriginPolicy,
} from "./http-utils.js";
import { handleOpenAiModelsHttpRequest } from "./models-http.js";
import { resolveRequestClientIp } from "./net.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";
import { authorizeCanvasRequest, isCanvasPath } from "./server/http-auth.js";
import { resolvePluginRouteRuntimeOperatorScopes } from "./server/plugin-route-runtime-scopes.js";
import {
  type PluginHttpRequestHandler,
  type PluginRoutePathContext,
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
} from "./server/plugins-http.js";
import type { PreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { handleSessionKillHttpRequest } from "./session-kill-http.js";
import { handleSessionHistoryHttpRequest } from "./sessions-history-http.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;

interface HookDispatchers {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
}

function resolveMappedHookExternalContentSource(params: {
  subPath: string;
  payload: Record<string, unknown>;
  sessionKey: string;
}) {
  const payloadSource = normalizeLowercaseStringOrEmpty(params.payload.source);
  if (params.subPath === "gmail" || payloadSource === "gmail") {
    return "gmail" as const;
  }
  return resolveHookExternalContentSourceFromSession(params.sessionKey) ?? "webhook";
}

export type HookClientIpConfig = Readonly<{
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}>;

interface HookReplayEntry {
  ts: number;
  runId: string;
}

interface HookReplayScope {
  pathKey: string;
  token: string | undefined;
  idempotencyKey?: string;
  dispatchScope: Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

const GATEWAY_PROBE_STATUS_BY_PATH = new Map<string, "live" | "ready">([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
]);
function resolvePluginGatewayAuthBypassPaths(
  configSnapshot: ReturnType<typeof loadConfig>,
): Set<string> {
  const paths = new Set<string>();
  for (const plugin of listBundledChannelPlugins()) {
    for (const path of plugin.gateway?.resolveGatewayAuthBypassPaths?.({ cfg: configSnapshot }) ??
      []) {
      if (typeof path === "string" && path.trim()) {
        paths.add(path.trim());
      }
    }
  }
  return paths;
}

function shouldEnforceDefaultPluginGatewayAuth(pathContext: PluginRoutePathContext): boolean {
  return (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    isProtectedPluginRoutePathFromContext(pathContext)
  );
}

async function canRevealReadinessDetails(params: {
  req: IncomingMessage;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  if (isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)) {
    return true;
  }
  if (params.resolvedAuth.mode === "none") {
    return false;
  }

  const bearerToken = getBearerToken(params.req);
  const authResult = await authorizeHttpGatewayConnect({
    allowRealIpFallback: params.allowRealIpFallback,
    auth: params.resolvedAuth,
    browserOriginPolicy: resolveHttpBrowserOriginPolicy(params.req),
    connectAuth: bearerToken ? { password: bearerToken, token: bearerToken } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
  });
  return authResult.ok;
}

async function handleGatewayProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  resolvedAuth: ResolvedGatewayAuth,
  trustedProxies: string[],
  allowRealIpFallback: boolean,
  getReadiness?: ReadinessChecker,
): Promise<boolean> {
  const status = GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath);
  if (!status) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  let statusCode: number;
  let body: string;
  if (status === "ready" && getReadiness) {
    const includeDetails = await canRevealReadinessDetails({
      allowRealIpFallback,
      req,
      resolvedAuth,
      trustedProxies,
    });
    try {
      const result = getReadiness();
      statusCode = result.ready ? 200 : 503;
      body = JSON.stringify(includeDetails ? result : { ready: result.ready });
    } catch {
      statusCode = 503;
      body = JSON.stringify(
        includeDetails ? { failing: ["internal"], ready: false, uptimeMs: 0 } : { ready: false },
      );
    }
  } else {
    statusCode = 200;
    body = JSON.stringify({ ok: true, status });
  }
  res.statusCode = statusCode;
  res.end(method === "HEAD" ? undefined : body);
  return true;
}

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

function writeUpgradeServiceUnavailable(
  socket: { write: (chunk: string) => void },
  responseBody: string,
) {
  socket.write(
    "HTTP/1.1 503 Service Unavailable\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(responseBody, "utf8")}\r\n` +
      "\r\n" +
      responseBody,
  );
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

interface GatewayHttpRequestStage {
  name: string;
  run: () => Promise<boolean> | boolean;
}

export async function runGatewayHttpRequestStages(
  stages: readonly GatewayHttpRequestStage[],
): Promise<boolean> {
  for (const stage of stages) {
    try {
      if (await stage.run()) {
        return true;
      }
    } catch (error) {
      // Log and skip the failing stage so subsequent stages (control-ui,
      // Gateway-probes, etc.) remain reachable.  A common trigger is a
      // Plugin-owned route/runtime code can still fail to load when an
      // Optional dependency is missing. Keep later stages reachable.
      console.error(`[gateway-http] stage "${stage.name}" threw — skipping:`, error);
    }
  }
  return false;
}

function buildPluginRequestStages(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  gatewayAuthBypassPaths: ReadonlySet<string>;
  pluginPathContext: PluginRoutePathContext | null;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
}): GatewayHttpRequestStage[] {
  if (!params.handlePluginRequest) {
    return [];
  }
  let pluginGatewayAuthSatisfied = false;
  let pluginGatewayRequestAuth: AuthorizedGatewayHttpRequest | undefined;
  let pluginRequestOperatorScopes: string[] | undefined;
  return [
    {
      name: "plugin-auth",
      run: async () => {
        if (params.gatewayAuthBypassPaths.has(params.requestPath)) {
          return false;
        }
        const pathContext =
          params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
        if (
          !(params.shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(
            pathContext,
          )
        ) {
          return false;
        }
        const requestAuth = await authorizeGatewayHttpRequestOrReply({
          allowRealIpFallback: params.allowRealIpFallback,
          auth: params.resolvedAuth,
          rateLimiter: params.rateLimiter,
          req: params.req,
          res: params.res,
          trustedProxies: params.trustedProxies,
        });
        if (!requestAuth) {
          return true;
        }
        pluginGatewayAuthSatisfied = true;
        pluginGatewayRequestAuth = requestAuth;
        pluginRequestOperatorScopes = resolvePluginRouteRuntimeOperatorScopes(
          params.req,
          requestAuth,
        );
        return false;
      },
    },
    {
      name: "plugin-http",
      run: () => {
        const pathContext =
          params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
        return (
          params.handlePluginRequest?.(params.req, params.res, pathContext, {
            gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
            gatewayRequestAuth: pluginGatewayRequestAuth,
            gatewayRequestOperatorScopes: pluginRequestOperatorScopes,
          }) ?? false
        );
      },
    },
  ];
}

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
    getClientIpConfig?: () => HookClientIpConfig;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook, getClientIpConfig } = opts;
  const hookReplayCache = new Map<string, HookReplayEntry>();
  const hookAuthLimiter = createAuthRateLimiter({
    maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
    windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    exemptLoopback: false,
    // Handler lifetimes are tied to gateway runtime/tests; skip background timer fanout.
    pruneIntervalMs: 0,
  });

  const resolveHookClientKey = (req: IncomingMessage): string => {
    const clientIpConfig = getClientIpConfig?.();
    const clientIp =
      resolveRequestClientIp(
        req,
        clientIpConfig?.trustedProxies,
        clientIpConfig?.allowRealIpFallback === true,
      ) ?? req.socket?.remoteAddress;
    return normalizeRateLimitClientIp(clientIp);
  };

  const pruneHookReplayCache = (now: number) => {
    const cutoff = now - DEDUPE_TTL_MS;
    for (const [key, entry] of hookReplayCache) {
      if (entry.ts < cutoff) {
        hookReplayCache.delete(key);
      }
    }
    while (hookReplayCache.size > DEDUPE_MAX) {
      const oldestKey = hookReplayCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      hookReplayCache.delete(oldestKey);
    }
  };

  const buildHookReplayCacheKey = (params: HookReplayScope): string | undefined => {
    const idem = params.idempotencyKey?.trim();
    if (!idem) {
      return undefined;
    }
    const tokenFingerprint = createHash("sha256")
      .update(params.token ?? "", "utf8")
      .digest("hex");
    const idempotencyFingerprint = createHash("sha256").update(idem, "utf8").digest("hex");
    const scopeFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          dispatchScope: params.dispatchScope,
          pathKey: params.pathKey,
        }),
        "utf8",
      )
      .digest("hex");
    return `${tokenFingerprint}:${scopeFingerprint}:${idempotencyFingerprint}`;
  };

  const resolveCachedHookRunId = (key: string | undefined, now: number): string | undefined => {
    if (!key) {
      return undefined;
    }
    pruneHookReplayCache(now);
    const cached = hookReplayCache.get(key);
    if (!cached) {
      return undefined;
    }
    hookReplayCache.delete(key);
    hookReplayCache.set(key, cached);
    return cached.runId;
  };

  const rememberHookRunId = (key: string | undefined, runId: string, now: number) => {
    if (!key) {
      return;
    }
    hookReplayCache.delete(key);
    hookReplayCache.set(key, { runId, ts: now });
    pruneHookReplayCache(now);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    // Only pathname/search are used here; keep the base host fixed so bind-host
    // Representation (e.g. IPv6 wildcards) cannot break request parsing.
    const url = new URL(req.url ?? "/", "http://localhost");
    const {basePath} = hooksConfig;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!safeEqualSecret(token, hooksConfig.token)) {
      const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      if (!throttle.allowed) {
        const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1000) : 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : (body.error === "request body timeout"
            ? 408
            : 400);
      sendJson(res, status, { error: body.error, ok: false });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);
    const idempotencyKey = resolveHookIdempotencyKey({
      headers,
      payload: payload as Record<string, unknown>,
    });
    const now = Date.now();

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { error: normalized.error, ok: false });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { mode: normalized.value.mode, ok: true });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { error: normalized.error, ok: false });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        sendJson(res, 400, { error: getHookAgentPolicyError(), ok: false });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        sessionKey: normalized.value.sessionKey,
        source: "request",
      });
      if (!sessionKey.ok) {
        sendJson(res, 400, { error: sessionKey.error, ok: false });
        return true;
      }
      const targetAgentId = resolveHookTargetAgentId(hooksConfig, normalized.value.agentId);
      const replayKey = buildHookReplayCacheKey({
        dispatchScope: {
          agentId: targetAgentId ?? null,
          channel: normalized.value.channel,
          deliver: normalized.value.deliver,
          message: normalized.value.message,
          model: normalized.value.model ?? null,
          name: normalized.value.name,
          sessionKey:
            normalized.value.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
          thinking: normalized.value.thinking ?? null,
          timeoutSeconds: normalized.value.timeoutSeconds ?? null,
          to: normalized.value.to ?? null,
          wakeMode: normalized.value.wakeMode,
        },
        idempotencyKey,
        pathKey: "agent",
        token,
      });
      const cachedRunId = resolveCachedHookRunId(replayKey, now);
      if (cachedRunId) {
        sendJson(res, 200, { ok: true, runId: cachedRunId });
        return true;
      }
      const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
        sessionKey: sessionKey.value,
        targetAgentId,
      });
      const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
      if (
        allowedPrefixes &&
        !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)
      ) {
        sendJson(res, 400, { error: getHookSessionKeyPrefixError(allowedPrefixes), ok: false });
        return true;
      }
      const runId = dispatchAgentHook({
        ...normalized.value,
        agentId: targetAgentId,
        externalContentSource: "webhook",
        idempotencyKey,
        sessionKey: normalizedDispatchSessionKey,
      });
      rememberHookRunId(replayKey, runId, now);
      sendJson(res, 200, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          headers,
          path: subPath,
          payload: payload as Record<string, unknown>,
          url,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { error: mapped.error, ok: false });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              mode: mapped.action.mode,
              text: mapped.action.text,
            });
            sendJson(res, 200, { mode: mapped.action.mode, ok: true });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { error: getHookChannelError(), ok: false });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            sendJson(res, 400, { error: getHookAgentPolicyError(), ok: false });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            sessionKey: mapped.action.sessionKey,
            source: "mapping",
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { error: sessionKey.error, ok: false });
            return true;
          }
          const targetAgentId = resolveHookTargetAgentId(hooksConfig, mapped.action.agentId);
          const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
            sessionKey: sessionKey.value,
            targetAgentId,
          });
          const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
          if (
            allowedPrefixes &&
            !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)
          ) {
            sendJson(res, 400, { error: getHookSessionKeyPrefixError(allowedPrefixes), ok: false });
            return true;
          }
          const replayKey = buildHookReplayCacheKey({
            dispatchScope: {
              agentId: targetAgentId ?? null,
              channel,
              deliver: resolveHookDeliver(mapped.action.deliver),
              message: mapped.action.message,
              model: mapped.action.model ?? null,
              name: mapped.action.name ?? "Hook",
              sessionKey:
                mapped.action.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
              thinking: mapped.action.thinking ?? null,
              timeoutSeconds: mapped.action.timeoutSeconds ?? null,
              to: mapped.action.to ?? null,
              wakeMode: mapped.action.wakeMode,
            },
            idempotencyKey,
            pathKey: subPath || "mapping",
            token,
          });
          const cachedRunId = resolveCachedHookRunId(replayKey, now);
          if (cachedRunId) {
            sendJson(res, 200, { ok: true, runId: cachedRunId });
            return true;
          }
          const runId = dispatchAgentHook({
            agentId: targetAgentId,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
            channel,
            deliver: resolveHookDeliver(mapped.action.deliver),
            externalContentSource: resolveMappedHookExternalContentSource({
              payload: payload as Record<string, unknown>,
              sessionKey: sessionKey.value,
              subPath,
            }),
            idempotencyKey,
            message: mapped.action.message,
            model: mapped.action.model,
            name: mapped.action.name ?? "Hook",
            sessionKey: normalizedDispatchSessionKey,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            to: mapped.action.to,
            wakeMode: mapped.action.wakeMode,
          });
          rememberHookRunId(replayKey, runId, now);
          sendJson(res, 200, { ok: true, runId });
          return true;
        }
      } catch (error) {
        logHooks.warn(`hook mapping failed: ${String(error)}`);
        sendJson(res, 500, { error: "hook mapping failed", ok: false });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  getReadiness?: ReadinessChecker;
  tlsOptions?: TlsOptions;
}): HttpServer {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    handleHooksRequest,
    handlePluginRequest,
    shouldEnforcePluginGatewayAuth,
    resolvedAuth,
    rateLimiter,
    getReadiness,
  } = opts;
  const openAiCompatEnabled = openAiChatCompletionsEnabled || openResponsesEnabled;
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: strictTransportSecurityHeader,
    });

    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (normalizeLowercaseStringOrEmpty(req.headers.upgrade) === "websocket") {
      return;
    }

    try {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      const gatewayAuthBypassPaths = resolvePluginGatewayAuthBypassPaths(configSnapshot);
      const pluginPathContext = handlePluginRequest
        ? resolvePluginRoutePathContext(requestPath)
        : null;
      const requestStages: GatewayHttpRequestStage[] = [
        {
          name: "hooks",
          run: () => handleHooksRequest(req, res),
        },
        {
          name: "models",
          run: () =>
            openAiCompatEnabled
              ? handleOpenAiModelsHttpRequest(req, res, {
                  allowRealIpFallback,
                  auth: resolvedAuth,
                  rateLimiter,
                  trustedProxies,
                })
              : false,
        },
        {
          name: "embeddings",
          run: () =>
            openAiCompatEnabled
              ? handleOpenAiEmbeddingsHttpRequest(req, res, {
                  allowRealIpFallback,
                  auth: resolvedAuth,
                  rateLimiter,
                  trustedProxies,
                })
              : false,
        },
        {
          name: "tools-invoke",
          run: () =>
            handleToolsInvokeHttpRequest(req, res, {
              allowRealIpFallback,
              auth: resolvedAuth,
              rateLimiter,
              trustedProxies,
            }),
        },
        {
          name: "sessions-kill",
          run: () =>
            handleSessionKillHttpRequest(req, res, {
              allowRealIpFallback,
              auth: resolvedAuth,
              rateLimiter,
              trustedProxies,
            }),
        },
        {
          name: "sessions-history",
          run: () =>
            handleSessionHistoryHttpRequest(req, res, {
              allowRealIpFallback,
              auth: resolvedAuth,
              rateLimiter,
              trustedProxies,
            }),
        },
      ];
      if (openResponsesEnabled) {
        requestStages.push({
          name: "openresponses",
          run: () =>
            handleOpenResponsesHttpRequest(req, res, {
              allowRealIpFallback,
              auth: resolvedAuth,
              config: openResponsesConfig,
              rateLimiter,
              trustedProxies,
            }),
        });
      }
      if (openAiChatCompletionsEnabled) {
        requestStages.push({
          name: "openai",
          run: () =>
            handleOpenAiHttpRequest(req, res, {
              allowRealIpFallback,
              auth: resolvedAuth,
              config: openAiChatCompletionsConfig,
              rateLimiter,
              trustedProxies,
            }),
        });
      }
      if (canvasHost) {
        requestStages.push({
          name: "canvas-auth",
          run: async () => {
            if (!isCanvasPath(requestPath)) {
              return false;
            }
            const ok = await authorizeCanvasRequest({
              allowRealIpFallback,
              auth: resolvedAuth,
              canvasCapability: scopedCanvas.capability,
              clients,
              malformedScopedPath: scopedCanvas.malformedScopedPath,
              rateLimiter,
              req,
              trustedProxies,
            });
            if (!ok.ok) {
              sendGatewayAuthFailure(res, ok);
              return true;
            }
            return false;
          },
        });
        requestStages.push({
          name: "a2ui",
          run: () => handleA2uiHttpRequest(req, res),
        });
        requestStages.push({
          name: "canvas-http",
          run: () => canvasHost.handleHttpRequest(req, res),
        });
      }
      // Plugin routes run before the Control UI SPA catch-all so explicitly
      // Registered plugin endpoints stay reachable. Core built-in gateway
      // Routes above still keep precedence on overlapping paths.
      requestStages.push(
        ...buildPluginRequestStages({
          allowRealIpFallback,
          gatewayAuthBypassPaths,
          handlePluginRequest,
          pluginPathContext,
          rateLimiter,
          req,
          requestPath,
          res,
          resolvedAuth,
          shouldEnforcePluginGatewayAuth,
          trustedProxies,
        }),
      );

      if (controlUiEnabled) {
        requestStages.push({
          name: "control-ui-avatar",
          run: () =>
            handleControlUiAvatarRequest(req, res, {
              basePath: controlUiBasePath,
              resolveAvatar: (agentId) =>
                resolveAgentAvatar(configSnapshot, agentId, { includeUiOverride: true }),
            }),
        });
        requestStages.push({
          name: "control-ui-http",
          run: () =>
            handleControlUiHttpRequest(req, res, {
              basePath: controlUiBasePath,
              config: configSnapshot,
              root: controlUiRoot,
            }),
        });
      }

      requestStages.push({
        name: "gateway-probes",
        run: () =>
          handleGatewayProbeRequest(
            req,
            res,
            requestPath,
            resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            getReadiness,
          ),
      });

      if (await runGatewayHttpRequestStages(requestStages)) {
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch (error) {
      console.error("[gateway-http] unhandled error in request handler:", error);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  preauthConnectionBudget: PreauthConnectionBudget;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
}) {
  const {
    httpServer,
    wss,
    canvasHost,
    clients,
    preauthConnectionBudget,
    resolvedAuth,
    rateLimiter,
  } = opts;
  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        writeUpgradeAuthFailure(socket, { ok: false, reason: "unauthorized" });
        socket.destroy();
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      if (canvasHost) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === CANVAS_WS_PATH) {
          const ok = await authorizeCanvasRequest({
            allowRealIpFallback,
            auth: resolvedAuth,
            canvasCapability: scopedCanvas.capability,
            clients,
            malformedScopedPath: scopedCanvas.malformedScopedPath,
            rateLimiter,
            req,
            trustedProxies,
          });
          if (!ok.ok) {
            writeUpgradeAuthFailure(socket, ok);
            socket.destroy();
            return;
          }
        }
        if (canvasHost.handleUpgrade(req, socket, head)) {
          return;
        }
      }
      const preauthBudgetKey = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback);
      // Keep startup upgrades inside the pre-auth budget until WS handlers attach.
      if (!preauthConnectionBudget.acquire(preauthBudgetKey)) {
        writeUpgradeServiceUnavailable(socket, "Too many unauthenticated sockets");
        socket.destroy();
        return;
      }
      if (wss.listenerCount("connection") === 0) {
        preauthConnectionBudget.release(preauthBudgetKey);
        writeUpgradeServiceUnavailable(socket, "Gateway websocket handlers unavailable");
        socket.destroy();
        return;
      }
      let budgetTransferred = false;
      const releaseUpgradeBudget = () => {
        if (budgetTransferred) {
          return;
        }
        budgetTransferred = true;
        preauthConnectionBudget.release(preauthBudgetKey);
      };
      socket.once("close", releaseUpgradeBudget);
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          (
            ws as unknown as import("ws").WebSocket & {
              __openclawPreauthBudgetClaimed?: boolean;
              __openclawPreauthBudgetKey?: string;
            }
          ).__openclawPreauthBudgetKey = preauthBudgetKey;
          wss.emit("connection", ws, req);
          const budgetClaimed = Boolean(
            (
              ws as unknown as import("ws").WebSocket & {
                __openclawPreauthBudgetClaimed?: boolean;
              }
            ).__openclawPreauthBudgetClaimed,
          );
          if (budgetClaimed) {
            budgetTransferred = true;
            socket.off("close", releaseUpgradeBudget);
          }
        });
      } catch {
        socket.off("close", releaseUpgradeBudget);
        releaseUpgradeBudget();
        throw new Error("gateway websocket upgrade failed");
      }
    })().catch(() => {
      socket.destroy();
    });
  });
}
