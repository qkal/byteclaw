import { vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsActivityHandler, MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import type { MSTeamsPollStore } from "./polls.js";

export function createActivityHandler(
  run = vi.fn(async () => undefined),
): MSTeamsActivityHandler & {
  run: NonNullable<MSTeamsActivityHandler["run"]>;
} {
  let handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  handler = {
    onMembersAdded: () => handler,
    onMessage: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };
  return handler;
}

export function createMSTeamsMessageHandlerDeps(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
}): MSTeamsMessageHandlerDeps {
  const adapter: MSTeamsAdapter = {
    continueConversation: async () => {},
    deleteActivity: async () => {},
    process: async () => {},
    updateActivity: async () => {},
  };
  const conversationStore: MSTeamsConversationStore = {
    findByUserId: async () => null,
    findPreferredDmByUserId: async () => null,
    get: async () => null,
    list: async () => [],
    remove: async () => false,
    upsert: async () => {},
  };
  const pollStore: MSTeamsPollStore = {
    createPoll: async () => {},
    getPoll: async () => null,
    recordVote: async () => null,
  };

  return {
    adapter,
    appId: "test-app-id",
    cfg: params?.cfg ?? {},
    conversationStore,
    log: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    mediaMaxBytes: 8 * 1024 * 1024,
    pollStore,
    runtime: (params?.runtime ?? { error: vi.fn() }) as RuntimeEnv,
    textLimit: 4000,
    tokenProvider: {
      getAccessToken: async () => "token",
    },
  };
}
