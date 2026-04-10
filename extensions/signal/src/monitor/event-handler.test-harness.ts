import type { SignalEventHandlerDeps, SignalReactionMessage } from "./event-handler.types.js";

export function createBaseSignalEventHandlerDeps(
  overrides: Partial<SignalEventHandlerDeps> = {},
): SignalEventHandlerDeps {
  return {
    accountId: "default",
    allowFrom: ["*"],
    baseUrl: "http://localhost",
    buildSignalReactionSystemEventText: () => "reaction",
    cfg: {},
    deliverReplies: async () => {},
    dmPolicy: "open",
    fetchAttachment: async () => null,
    groupAllowFrom: ["*"],
    groupHistories: new Map(),
    groupPolicy: "open",
    historyLimit: 5,
    ignoreAttachments: true,
    isSignalReactionMessage: (
      _reaction: SignalReactionMessage | null | undefined,
    ): _reaction is SignalReactionMessage => false,
    mediaMaxBytes: 1024,
    reactionAllowlist: [],
    reactionMode: "off",
    readReceiptsViaDaemon: false,
    resolveSignalReactionTargets: () => [],
    runtime: { error: () => {}, log: () => {} } as any,
    sendReadReceipts: false,
    shouldEmitSignalReactionNotification: () => false,
    textLimit: 4000,
    ...overrides,
  };
}

export function createSignalReceiveEvent(envelopeOverrides: Record<string, unknown> = {}) {
  return {
    data: JSON.stringify({
      envelope: {
        sourceName: "Alice",
        sourceNumber: "+15550001111",
        timestamp: 1700000000000,
        ...envelopeOverrides,
      },
    }),
    event: "receive",
  };
}
