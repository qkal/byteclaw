import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleAbortTrigger } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";

const abortEmbeddedPiRunMock = vi.hoisted(() => vi.fn());
const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn());
const setAbortMemoryMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: abortEmbeddedPiRunMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("./abort.js", () => ({
  formatAbortReplyText: vi.fn(() => "⚙️ Agent was aborted."),
  isAbortTrigger: vi.fn((raw: string) => raw === "stop"),
  resolveSessionEntryForKey: vi.fn(() => ({ entry: undefined, key: "agent:main:main" })),
  setAbortMemory: setAbortMemoryMock,
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
}));

vi.mock("./queue.js", () => ({
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, keys: [], laneCleared: 0 })),
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    abort: vi.fn(),
    resolveSessionId: vi.fn(() => undefined),
  },
}));

function buildAbortParams(): HandleCommandsParams {
  return {
    cfg: {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
    } as OpenClawConfig,
    command: {
      channel: "whatsapp",
      channelId: "whatsapp",
      commandBodyNormalized: "stop",
      from: "unauthorized",
      isAuthorizedSender: false,
      ownerList: [],
      rawBodyNormalized: "stop",
      senderId: "unauthorized",
      senderIsOwner: false,
      surface: "whatsapp",
      to: "bot",
    },
    ctx: {
      CommandSource: "text",
      Provider: "whatsapp",
      Surface: "whatsapp",
    },
    sessionEntry: {
      abortedLastRun: false,
      sessionId: "session-1",
      updatedAt: Date.now(),
    },
    sessionKey: "agent:main:main",
    sessionStore: {
      "agent:main:main": {
        abortedLastRun: false,
        sessionId: "session-1",
        updatedAt: Date.now(),
      },
    },
  } as unknown as HandleCommandsParams;
}

describe("handleAbortTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthorized natural-language abort triggers", async () => {
    const result = await handleAbortTrigger(buildAbortParams(), true);
    expect(result).toEqual({ shouldContinue: false });
    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
  });
});
