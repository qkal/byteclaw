import type { HistoryEntry, PluginRuntime } from "openclaw/plugin-sdk/bluebubbles";
import { vi } from "vitest";
import { createPluginRuntimeMock } from "../../../../test/helpers/plugins/plugin-runtime-mock.js";
import {
  _resetBlueBubblesShortIdState,
  clearBlueBubblesWebhookSecurityStateForTest,
} from "../monitor.js";
import { setBlueBubblesRuntime } from "../runtime.js";

interface BlueBubblesHistoryFetchResult {
  entries: HistoryEntry[];
  resolved: boolean;
}

export type DispatchReplyParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

export const EMPTY_DISPATCH_RESULT = {
  counts: { block: 0, final: 0, tool: 0 },
  queuedFinal: false,
} as const;

interface BlueBubblesMonitorTestRuntimeMocks {
  enqueueSystemEvent: PluginRuntime["system"]["enqueueSystemEvent"];
  chunkMarkdownText: PluginRuntime["channel"]["text"]["chunkMarkdownText"];
  chunkByNewline: PluginRuntime["channel"]["text"]["chunkByNewline"];
  chunkMarkdownTextWithMode: PluginRuntime["channel"]["text"]["chunkMarkdownTextWithMode"];
  chunkTextWithMode: PluginRuntime["channel"]["text"]["chunkTextWithMode"];
  resolveChunkMode: PluginRuntime["channel"]["text"]["resolveChunkMode"];
  hasControlCommand: PluginRuntime["channel"]["text"]["hasControlCommand"];
  dispatchReplyWithBufferedBlockDispatcher: PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
  formatAgentEnvelope: PluginRuntime["channel"]["reply"]["formatAgentEnvelope"];
  formatInboundEnvelope: PluginRuntime["channel"]["reply"]["formatInboundEnvelope"];
  resolveEnvelopeFormatOptions: PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"];
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
  buildPairingReply: PluginRuntime["channel"]["pairing"]["buildPairingReply"];
  readAllowFromStore: PluginRuntime["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest: PluginRuntime["channel"]["pairing"]["upsertPairingRequest"];
  saveMediaBuffer: PluginRuntime["channel"]["media"]["saveMediaBuffer"];
  resolveStorePath: PluginRuntime["channel"]["session"]["resolveStorePath"];
  readSessionUpdatedAt: PluginRuntime["channel"]["session"]["readSessionUpdatedAt"];
  buildMentionRegexes: PluginRuntime["channel"]["mentions"]["buildMentionRegexes"];
  matchesMentionPatterns: PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"];
  matchesMentionWithExplicit: PluginRuntime["channel"]["mentions"]["matchesMentionWithExplicit"];
  resolveGroupPolicy: PluginRuntime["channel"]["groups"]["resolveGroupPolicy"];
  resolveRequireMention: PluginRuntime["channel"]["groups"]["resolveRequireMention"];
  resolveCommandAuthorizedFromAuthorizers: PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"];
}

export function createBlueBubblesMonitorTestRuntime(
  mocks: BlueBubblesMonitorTestRuntimeMocks,
): PluginRuntime {
  // Keep this helper small and explicit: BlueBubbles tests should only pay for the
  // Runtime slices monitor coverage actually consumes, while still tracking contract drift.
  return createPluginRuntimeMock({
    channel: {
      commands: {
        resolveCommandAuthorizedFromAuthorizers: mocks.resolveCommandAuthorizedFromAuthorizers,
      },
      groups: {
        resolveGroupPolicy: mocks.resolveGroupPolicy,
        resolveRequireMention: mocks.resolveRequireMention,
      },
      media: {
        saveMediaBuffer: mocks.saveMediaBuffer,
      },
      mentions: {
        buildMentionRegexes: mocks.buildMentionRegexes,
        matchesMentionPatterns: mocks.matchesMentionPatterns,
        matchesMentionWithExplicit: mocks.matchesMentionWithExplicit,
      },
      pairing: {
        buildPairingReply: mocks.buildPairingReply,
        readAllowFromStore: mocks.readAllowFromStore,
        upsertPairingRequest: mocks.upsertPairingRequest,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: mocks.dispatchReplyWithBufferedBlockDispatcher,
        formatAgentEnvelope: mocks.formatAgentEnvelope,
        formatInboundEnvelope: mocks.formatInboundEnvelope,
        resolveEnvelopeFormatOptions: mocks.resolveEnvelopeFormatOptions,
      },
      routing: {
        resolveAgentRoute: mocks.resolveAgentRoute,
      },
      session: {
        readSessionUpdatedAt: mocks.readSessionUpdatedAt,
        resolveStorePath: mocks.resolveStorePath,
      },
      text: {
        chunkByNewline: mocks.chunkByNewline,
        chunkMarkdownText: mocks.chunkMarkdownText,
        chunkMarkdownTextWithMode: mocks.chunkMarkdownTextWithMode,
        chunkTextWithMode: mocks.chunkTextWithMode,
        hasControlCommand: mocks.hasControlCommand,
        resolveChunkMode: mocks.resolveChunkMode,
      },
    },
    system: {
      enqueueSystemEvent: mocks.enqueueSystemEvent,
    },
  });
}

export function resetBlueBubblesMonitorTestState(params: {
  createRuntime: () => PluginRuntime;
  fetchHistoryMock: { mockResolvedValue: (value: BlueBubblesHistoryFetchResult) => unknown };
  readAllowFromStoreMock: { mockResolvedValue: (value: string[]) => unknown };
  upsertPairingRequestMock: {
    mockResolvedValue: (value: { code: string; created: boolean }) => unknown;
  };
  resolveRequireMentionMock: { mockReturnValue: (value: boolean) => unknown };
  hasControlCommandMock: { mockReturnValue: (value: boolean) => unknown };
  resolveCommandAuthorizedFromAuthorizersMock: { mockReturnValue: (value: boolean) => unknown };
  buildMentionRegexesMock: { mockReturnValue: (value: RegExp[]) => unknown };
  extraReset?: () => void;
}) {
  vi.clearAllMocks();
  _resetBlueBubblesShortIdState();
  clearBlueBubblesWebhookSecurityStateForTest();
  params.extraReset?.();
  params.fetchHistoryMock.mockResolvedValue({ entries: [], resolved: true });
  params.readAllowFromStoreMock.mockResolvedValue([]);
  params.upsertPairingRequestMock.mockResolvedValue({ code: "TESTCODE", created: true });
  params.resolveRequireMentionMock.mockReturnValue(false);
  params.hasControlCommandMock.mockReturnValue(false);
  params.resolveCommandAuthorizedFromAuthorizersMock.mockReturnValue(false);
  params.buildMentionRegexesMock.mockReturnValue([/\bbert\b/i]);
  setBlueBubblesRuntime(params.createRuntime());
}
