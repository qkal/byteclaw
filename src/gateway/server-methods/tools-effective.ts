import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsEffectiveParams,
} from "../protocol/index.js";
import {
  deliveryContextFromSession,
  listAgentIds,
  loadConfig,
  loadSessionEntry,
  resolveEffectiveToolInventory,
  resolveReplyToMode,
  resolveSessionAgentId,
  resolveSessionModelRef,
} from "./tools-effective.runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function resolveRequestedAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  cfg: ReturnType<typeof loadConfig>;
  respond: RespondFn;
}) {
  const knownAgents = listAgentIds(params.cfg);
  const requestedAgentId = normalizeOptionalString(params.rawAgentId) ?? "";
  if (!requestedAgentId) {
    return undefined;
  }
  if (!knownAgents.includes(requestedAgentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return requestedAgentId;
}

function resolveTrustedToolsEffectiveContext(params: {
  sessionKey: string;
  requestedAgentId?: string;
  senderIsOwner: boolean;
  respond: RespondFn;
}) {
  const loaded = loadSessionEntry(params.sessionKey);
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const sessionAgentId = resolveSessionAgentId({
    config: loaded.cfg,
    sessionKey: loaded.canonicalKey ?? params.sessionKey,
  });
  if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`,
      ),
    );
    return null;
  }

  const delivery = deliveryContextFromSession(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  return {
    accountId: delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
    agentId: sessionAgentId,
    cfg: loaded.cfg,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? String(delivery.threadId)
        : loaded.entry.lastThreadId != null
          ? String(loaded.entry.lastThreadId)
          : loaded.entry.origin?.threadId != null
            ? String(loaded.entry.origin.threadId)
            : undefined,
    groupChannel: loaded.entry.groupChannel,
    groupId: loaded.entry.groupId,
    groupSpace: loaded.entry.space,
    messageProvider:
      delivery?.channel ??
      loaded.entry.lastChannel ??
      loaded.entry.channel ??
      loaded.entry.origin?.provider,
    modelId: resolvedModel.model,
    modelProvider: resolvedModel.provider,
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ??
        loaded.entry.lastChannel ??
        loaded.entry.channel ??
        loaded.entry.origin?.provider,
      delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
      loaded.entry.chatType ?? loaded.entry.origin?.chatType,
    ),
    senderIsOwner: params.senderIsOwner,
  };
}

export const toolsEffectiveHandlers: GatewayRequestHandlers = {
  "tools.effective": ({ params, respond, client }) => {
    if (!validateToolsEffectiveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.effective params: ${formatValidationErrors(validateToolsEffectiveParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const requestedAgentId = resolveRequestedAgentIdOrRespondError({
      cfg,
      rawAgentId: params.agentId,
      respond,
    });
    if (requestedAgentId === null) {
      return;
    }
    const trustedContext = resolveTrustedToolsEffectiveContext({
      requestedAgentId,
      respond,
      senderIsOwner: Array.isArray(client?.connect?.scopes)
        ? client.connect.scopes.includes(ADMIN_SCOPE)
        : false,
      sessionKey: params.sessionKey,
    });
    if (!trustedContext) {
      return;
    }
    respond(
      true,
      resolveEffectiveToolInventory({
        accountId: trustedContext.accountId,
        agentId: trustedContext.agentId,
        cfg: trustedContext.cfg,
        currentChannelId: trustedContext.currentChannelId,
        currentThreadTs: trustedContext.currentThreadTs,
        groupChannel: trustedContext.groupChannel,
        groupId: trustedContext.groupId,
        groupSpace: trustedContext.groupSpace,
        messageProvider: trustedContext.messageProvider,
        modelId: trustedContext.modelId,
        modelProvider: trustedContext.modelProvider,
        replyToMode: trustedContext.replyToMode,
        senderIsOwner: trustedContext.senderIsOwner,
        sessionKey: params.sessionKey,
      }),
      undefined,
    );
  },
};
