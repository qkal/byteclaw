import type { IncomingMessage, ServerResponse } from "node:http";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendInvalidRequest, sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  type AuthorizedGatewayHttpRequest,
  OPENCLAW_DEFAULT_MODEL_ID,
  OPENCLAW_MODEL_ID,
  authorizeGatewayHttpRequestOrReply,
  resolveAgentIdFromModel,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

interface OpenAiModelsHttpOptions {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}

interface OpenAiModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  permission: [];
}

function toOpenAiModel(id: string): OpenAiModelObject {
  return {
    created: 0,
    id,
    object: "model",
    owned_by: "openclaw",
    permission: [],
  };
}

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<AuthorizedGatewayHttpRequest | null> {
  return await authorizeGatewayHttpRequestOrReply({
    allowRealIpFallback: opts.allowRealIpFallback,
    auth: opts.auth,
    rateLimiter: opts.rateLimiter,
    req,
    res,
    trustedProxies: opts.trustedProxies,
  });
}

function loadAgentModelIds(): string[] {
  const cfg = loadConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const ids = new Set<string>([OPENCLAW_MODEL_ID, OPENCLAW_DEFAULT_MODEL_ID]);
  ids.add(`openclaw/${defaultAgentId}`);
  for (const agentId of listAgentIds(cfg)) {
    ids.add(`openclaw/${agentId}`);
  }
  return [...ids];
}

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).pathname;
}

export async function handleOpenAiModelsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (requestPath !== "/v1/models" && !requestPath.startsWith("/v1/models/")) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const requestAuth = await authorizeRequest(req, res, opts);
  if (!requestAuth) {
    return true;
  }

  const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("models.list", requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(res, 403, {
      error: {
        message: `missing scope: ${scopeAuth.missingScope}`,
        type: "forbidden",
      },
      ok: false,
    });
    return true;
  }

  const ids = loadAgentModelIds();
  if (requestPath === "/v1/models") {
    sendJson(res, 200, {
      data: ids.map(toOpenAiModel),
      object: "list",
    });
    return true;
  }

  const encodedId = requestPath.slice("/v1/models/".length);
  if (!encodedId) {
    sendInvalidRequest(res, "Missing model id.");
    return true;
  }

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(encodedId);
  } catch {
    sendInvalidRequest(res, "Invalid model id encoding.");
    return true;
  }

  if (decodedId !== OPENCLAW_MODEL_ID && !resolveAgentIdFromModel(decodedId)) {
    sendInvalidRequest(res, "Invalid model id.");
    return true;
  }

  if (!ids.includes(decodedId)) {
    sendJson(res, 404, {
      error: {
        message: `Model '${decodedId}' not found.`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  sendJson(res, 200, toOpenAiModel(decodedId));
  return true;
}
