export function createBaseToolHandlerState() {
  return {
    blockBuffer: "",
    deterministicApprovalPromptPending: false,
    deterministicApprovalPromptSent: false,
    itemActiveIds: new Set<string>(),
    itemCompletedCount: 0,
    itemStartedCount: 0,
    lastToolError: undefined,
    messagingToolSentMediaUrls: [] as string[],
    messagingToolSentTargets: [] as unknown[],
    messagingToolSentTexts: [] as string[],
    messagingToolSentTextsNormalized: [] as string[],
    pendingMessagingMediaUrls: new Map<string, string[]>(),
    pendingMessagingTargets: new Map<string, unknown>(),
    pendingMessagingTexts: new Map<string, string>(),
    pendingToolAudioAsVoice: false,
    pendingToolMediaUrls: [] as string[],
    toolMetaById: new Map<string, unknown>(),
    toolMetas: [] as { toolName?: string; meta?: string }[],
    toolSummaryById: new Set<string>(),
  };
}
