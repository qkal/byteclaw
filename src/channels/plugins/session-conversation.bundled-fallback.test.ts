import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";

const fallbackState = vi.hoisted(() => ({
  activeDirName: null as string | null,
  resolveSessionConversation: null as
    | ((params: { kind: "group" | "channel"; rawId: string }) => {
        id: string;
        threadId?: string | null;
        baseConversationId?: string | null;
        parentConversationCandidates?: string[];
      } | null)
    | null,
}));

vi.mock("../../plugin-sdk/facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugin-sdk/facade-runtime.js")>(
    "../../plugin-sdk/facade-runtime.js",
  );
  return {
    ...actual,
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync: ({ dirName }: { dirName: string }) =>
      dirName === fallbackState.activeDirName && fallbackState.resolveSessionConversation
        ? { resolveSessionConversation: fallbackState.resolveSessionConversation }
        : null,
  };
});

import { resolveSessionConversationRef } from "./session-conversation.js";

describe("session conversation bundled fallback", () => {
  beforeEach(() => {
    fallbackState.activeDirName = null;
    fallbackState.resolveSessionConversation = null;
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("delegates pre-bootstrap thread parsing to the active bundled channel plugin", () => {
    fallbackState.activeDirName = "mock-threaded";
    fallbackState.resolveSessionConversation = ({ rawId }) => {
      const [conversationId, threadId] = rawId.split(":topic:");
      return {
        baseConversationId: conversationId,
        id: conversationId,
        parentConversationCandidates: [conversationId],
        threadId,
      };
    };
    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          "mock-threaded": {
            enabled: true,
          },
        },
      },
    });

    expect(resolveSessionConversationRef("agent:main:mock-threaded:group:room:topic:42")).toEqual({
      baseConversationId: "room",
      baseSessionKey: "agent:main:mock-threaded:group:room",
      channel: "mock-threaded",
      id: "room",
      kind: "group",
      parentConversationCandidates: ["room"],
      rawId: "room:topic:42",
      threadId: "42",
    });
  });

  it("uses explicit bundled parent candidates before registry bootstrap", () => {
    fallbackState.activeDirName = "mock-parent";
    fallbackState.resolveSessionConversation = ({ rawId }) => ({
      baseConversationId: "room",
      id: rawId,
      parentConversationCandidates: ["room:topic:root", "room"],
    });
    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          "mock-parent": {
            enabled: true,
          },
        },
      },
    });

    expect(
      resolveSessionConversationRef("agent:main:mock-parent:group:room:topic:root:sender:user"),
    ).toEqual({
      baseConversationId: "room",
      baseSessionKey: "agent:main:mock-parent:group:room:topic:root:sender:user",
      channel: "mock-parent",
      id: "room:topic:root:sender:user",
      kind: "group",
      parentConversationCandidates: ["room:topic:root", "room"],
      rawId: "room:topic:root:sender:user",
      threadId: undefined,
    });
  });
});
