/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export interface MentionGateParams {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  shouldBypassMention?: boolean;
}

/** @deprecated Prefer `InboundMentionDecision`. */
export interface MentionGateResult {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
}

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export interface MentionGateWithBypassParams {
  isGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  hasAnyMention?: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}

/** @deprecated Prefer `InboundMentionDecision`. */
export type MentionGateWithBypassResult = MentionGateResult & {
  shouldBypassMention: boolean;
};

export type InboundImplicitMentionKind =
  | "reply_to_bot"
  | "quoted_bot"
  | "bot_thread_participant"
  | "native";

export interface InboundMentionFacts {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
}

export interface InboundMentionPolicy {
  isGroup: boolean;
  requireMention: boolean;
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}

/** @deprecated Prefer the nested `{ facts, policy }` call shape for new code. */
export type ResolveInboundMentionDecisionFlatParams = InboundMentionFacts & InboundMentionPolicy;

export interface ResolveInboundMentionDecisionNestedParams {
  facts: InboundMentionFacts;
  policy: InboundMentionPolicy;
}

export type ResolveInboundMentionDecisionParams =
  | ResolveInboundMentionDecisionFlatParams
  | ResolveInboundMentionDecisionNestedParams;

export type InboundMentionDecision = MentionGateResult & {
  implicitMention: boolean;
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
};

export function implicitMentionKindWhen(
  kind: InboundImplicitMentionKind,
  enabled: boolean,
): InboundImplicitMentionKind[] {
  return enabled ? [kind] : [];
}

function resolveMatchedImplicitMentionKinds(params: {
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
}): InboundImplicitMentionKind[] {
  const inputKinds = params.implicitMentionKinds ?? [];
  if (inputKinds.length === 0) {
    return [];
  }
  const allowedKinds = params.allowedImplicitMentionKinds
    ? new Set(params.allowedImplicitMentionKinds)
    : null;
  const matched: InboundImplicitMentionKind[] = [];
  for (const kind of inputKinds) {
    if (allowedKinds && !allowedKinds.has(kind)) {
      continue;
    }
    if (!matched.includes(kind)) {
      matched.push(kind);
    }
  }
  return matched;
}

function resolveMentionDecisionCore(params: {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
}): InboundMentionDecision {
  const matchedImplicitMentionKinds = resolveMatchedImplicitMentionKinds({
    allowedImplicitMentionKinds: params.allowedImplicitMentionKinds,
    implicitMentionKinds: params.implicitMentionKinds,
  });
  const implicitMention = matchedImplicitMentionKinds.length > 0;
  const effectiveWasMentioned =
    params.wasMentioned || implicitMention || params.shouldBypassMention;
  const shouldSkip = params.requireMention && params.canDetectMention && !effectiveWasMentioned;
  return {
    effectiveWasMentioned,
    implicitMention,
    matchedImplicitMentionKinds,
    shouldBypassMention: params.shouldBypassMention,
    shouldSkip,
  };
}

function hasNestedMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): params is ResolveInboundMentionDecisionNestedParams {
  return "facts" in params && "policy" in params;
}

function normalizeMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): ResolveInboundMentionDecisionNestedParams {
  if (hasNestedMentionDecisionParams(params)) {
    return params;
  }
  const {
    canDetectMention,
    wasMentioned,
    hasAnyMention,
    implicitMentionKinds,
    isGroup,
    requireMention,
    allowedImplicitMentionKinds,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  } = params;
  return {
    facts: {
      canDetectMention,
      hasAnyMention,
      implicitMentionKinds,
      wasMentioned,
    },
    policy: {
      allowTextCommands,
      allowedImplicitMentionKinds,
      commandAuthorized,
      hasControlCommand,
      isGroup,
      requireMention,
    },
  };
}

export function resolveInboundMentionDecision(
  params: ResolveInboundMentionDecisionParams,
): InboundMentionDecision {
  const { facts, policy } = normalizeMentionDecisionParams(params);
  const shouldBypassMention =
    policy.isGroup &&
    policy.requireMention &&
    !facts.wasMentioned &&
    !(facts.hasAnyMention ?? false) &&
    policy.allowTextCommands &&
    policy.commandAuthorized &&
    policy.hasControlCommand;
  return resolveMentionDecisionCore({
    allowedImplicitMentionKinds: policy.allowedImplicitMentionKinds,
    canDetectMention: facts.canDetectMention,
    implicitMentionKinds: facts.implicitMentionKinds,
    requireMention: policy.requireMention,
    shouldBypassMention,
    wasMentioned: facts.wasMentioned,
  });
}

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export function resolveMentionGating(params: MentionGateParams): MentionGateResult {
  const result = resolveMentionDecisionCore({
    canDetectMention: params.canDetectMention,
    implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true),
    requireMention: params.requireMention,
    shouldBypassMention: params.shouldBypassMention === true,
    wasMentioned: params.wasMentioned,
  });
  return {
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldSkip: result.shouldSkip,
  };
}

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export function resolveMentionGatingWithBypass(
  params: MentionGateWithBypassParams,
): MentionGateWithBypassResult {
  const result = resolveInboundMentionDecision({
    facts: {
      canDetectMention: params.canDetectMention,
      hasAnyMention: params.hasAnyMention,
      implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true),
      wasMentioned: params.wasMentioned,
    },
    policy: {
      allowTextCommands: params.allowTextCommands,
      commandAuthorized: params.commandAuthorized,
      hasControlCommand: params.hasControlCommand,
      isGroup: params.isGroup,
      requireMention: params.requireMention,
    },
  });
  return {
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldBypassMention: result.shouldBypassMention,
    shouldSkip: result.shouldSkip,
  };
}
