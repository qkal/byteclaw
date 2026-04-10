import { vi } from "vitest";
import { createIMessageTestPlugin } from "../../../test/helpers/channels/imessage-test-plugin.js";
import {
  imessageOutboundForTest,
  signalOutbound,
  whatsappOutbound,
} from "../../../test/helpers/infra/deliver-test-outbounds.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { DeliverOutboundPayloadsParams, OutboundDeliveryResult } from "./deliver.js";

interface DeliverMockState {
  sessions: {
    appendAssistantMessageToSessionTranscript: (...args: unknown[]) => Promise<{
      ok: boolean;
      sessionFile: string;
    }>;
  };
  hooks: {
    runner: {
      hasHooks: (...args: unknown[]) => boolean;
      runMessageSent: (...args: unknown[]) => Promise<void>;
    };
  };
  internalHooks: {
    createInternalHookEvent: typeof createInternalHookEventPayload;
    triggerInternalHook: (...args: unknown[]) => Promise<void>;
  };
  queue: {
    enqueueDelivery: (...args: unknown[]) => Promise<string>;
    ackDelivery: (...args: unknown[]) => Promise<void>;
    failDelivery: (...args: unknown[]) => Promise<void>;
  };
  log: {
    warn: (...args: unknown[]) => void;
  };
}

export const deliverMocks: DeliverMockState = {
  hooks: {
    runner: {
      hasHooks: () => false,
      runMessageSent: async () => {},
    },
  },
  internalHooks: {
    createInternalHookEvent: createInternalHookEventPayload,
    triggerInternalHook: async () => {},
  },
  log: {
    warn: () => {},
  },
  queue: {
    ackDelivery: async () => {},
    enqueueDelivery: async () => "mock-queue-id",
    failDelivery: async () => {},
  },
  sessions: {
    appendAssistantMessageToSessionTranscript: async () => ({ ok: true, sessionFile: "x" }),
  },
};

const _mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () =>
    deliverMocks.sessions.appendAssistantMessageToSessionTranscript(),
  ),
}));
const _hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => deliverMocks.hooks.runner.hasHooks()),
    runMessageSent: vi.fn(
      async (...args: unknown[]) => await deliverMocks.hooks.runner.runMessageSent(...args),
    ),
  },
}));
const _internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn((...args: Parameters<typeof createInternalHookEventPayload>) =>
    deliverMocks.internalHooks.createInternalHookEvent(...args),
  ),
  triggerInternalHook: vi.fn(
    async (...args: unknown[]) => await deliverMocks.internalHooks.triggerInternalHook(...args),
  ),
}));
const _queueMocks = vi.hoisted(() => ({
  ackDelivery: vi.fn(async (...args: unknown[]) => await deliverMocks.queue.ackDelivery(...args)),
  enqueueDelivery: vi.fn(
    async (...args: unknown[]) => await deliverMocks.queue.enqueueDelivery(...args),
  ),
  failDelivery: vi.fn(async (...args: unknown[]) => await deliverMocks.queue.failDelivery(...args)),
}));
const _logMocks = vi.hoisted(() => ({
  warn: vi.fn((...args: unknown[]) => deliverMocks.log.warn(...args)),
}));

export const mocks = _mocks;
export const hookMocks = _hookMocks;
export const internalHookMocks = _internalHookMocks;
export const queueMocks = _queueMocks;
export const logMocks = _logMocks;

vi.mock("../../config/sessions/transcript.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/transcript.runtime.js")
  >("../../config/sessions/transcript.runtime.js");
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: _mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../config/sessions/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/transcript.js")>(
    "../../config/sessions/transcript.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: _mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => _hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: _internalHookMocks.createInternalHookEvent,
  triggerInternalHook: _internalHookMocks.triggerInternalHook,
}));
vi.mock("./delivery-queue.js", () => ({
  ackDelivery: _queueMocks.ackDelivery,
  enqueueDelivery: _queueMocks.enqueueDelivery,
  failDelivery: _queueMocks.failDelivery,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const makeLogger = () => ({
      child: vi.fn(() => makeLogger()),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: _logMocks.warn,
    });
    return makeLogger();
  },
}));

export const whatsappChunkConfig: OpenClawConfig = {
  channels: { whatsapp: { textChunkLimit: 4000 } },
};

export const defaultRegistry = createTestRegistry([
  {
    plugin: createOutboundTestPlugin({
      id: "signal",
      outbound: signalOutbound,
    }),
    pluginId: "signal",
    source: "test",
  },
  {
    plugin: createOutboundTestPlugin({
      id: "whatsapp",
      outbound: whatsappOutbound,
    }),
    pluginId: "whatsapp",
    source: "test",
  },
  {
    plugin: createIMessageTestPlugin({ outbound: imessageOutboundForTest }),
    pluginId: "imessage",
    source: "test",
  },
]);

export const emptyRegistry = createTestRegistry([]);

export function resetDeliverTestState() {
  releasePinnedPluginChannelRegistry();
  setActivePluginRegistry(defaultRegistry);
  deliverMocks.hooks.runner.hasHooks = () => false;
  deliverMocks.hooks.runner.runMessageSent = async () => {};
  deliverMocks.internalHooks.createInternalHookEvent = createInternalHookEventPayload;
  deliverMocks.internalHooks.triggerInternalHook = async () => {};
  deliverMocks.queue.enqueueDelivery = async () => "mock-queue-id";
  deliverMocks.queue.ackDelivery = async () => {};
  deliverMocks.queue.failDelivery = async () => {};
  deliverMocks.log.warn = () => {};
  deliverMocks.sessions.appendAssistantMessageToSessionTranscript = async () => ({
    ok: true,
    sessionFile: "x",
  });
}

export function clearDeliverTestRegistry() {
  releasePinnedPluginChannelRegistry();
  setActivePluginRegistry(emptyRegistry);
}

export function resetDeliverTestMocks(params?: { includeSessionMocks?: boolean }) {
  hookMocks.runner.hasHooks.mockClear();
  hookMocks.runner.runMessageSent.mockClear();
  internalHookMocks.createInternalHookEvent.mockClear();
  internalHookMocks.triggerInternalHook.mockClear();
  queueMocks.enqueueDelivery.mockClear();
  queueMocks.ackDelivery.mockClear();
  queueMocks.failDelivery.mockClear();
  logMocks.warn.mockClear();
  if (params?.includeSessionMocks) {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
  }
}

export async function runChunkedWhatsAppDelivery(params: {
  deliverOutboundPayloads: (
    params: DeliverOutboundPayloadsParams,
  ) => Promise<OutboundDeliveryResult[]>;
  mirror?: DeliverOutboundPayloadsParams["mirror"];
}) {
  const sendWhatsApp = vi
    .fn<
      (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
    >()
    .mockResolvedValueOnce({ messageId: "w1", toJid: "jid" })
    .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
  const cfg: OpenClawConfig = {
    channels: { whatsapp: { textChunkLimit: 2 } },
  };
  const results = await params.deliverOutboundPayloads({
    cfg,
    channel: "whatsapp",
    deps: { whatsapp: sendWhatsApp },
    payloads: [{ text: "abcd" }],
    to: "+1555",
    ...(params.mirror ? { mirror: params.mirror } : {}),
  });
  return { results, sendWhatsApp };
}
