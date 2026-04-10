import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  __testing,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  resolveGenericCurrentConversationBinding,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
          id: "slack",
          meta: { aliases: [] },
        },
        pluginId: "slack",
        source: "test",
      },
    ]),
  );
}

describe("generic current-conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    setMinimalCurrentConversationRegistry();
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
  });

  afterEach(async () => {
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { force: true, recursive: true });
  });

  it("advertises support only for channels that opt into current-conversation binds", () => {
    expect(
      getGenericCurrentConversationBindingCapabilities({
        accountId: "default",
        channel: "slack",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current"],
      unbindSupported: true,
    });
    expect(
      getGenericCurrentConversationBindingCapabilities({
        accountId: "default",
        channel: "definitely-not-a-channel",
      }),
    ).toBeNull();
  });

  it("requires an active channel plugin registration", () => {
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      getGenericCurrentConversationBindingCapabilities({
        accountId: "default",
        channel: "slack",
      }),
    ).toBeNull();
  });

  it("reloads persisted bindings after the in-memory cache is cleared", async () => {
    const bound = await bindGenericCurrentConversation({
      conversation: {
        accountId: "default",
        channel: "slack",
        conversationId: "user:U123",
      },
      metadata: {
        label: "slack-dm",
      },
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:slack-dm",
    });

    expect(bound).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:slack-dm",
    });

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        accountId: "default",
        channel: "slack",
        conversationId: "user:U123",
      }),
    ).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      metadata: expect.objectContaining({
        label: "slack-dm",
      }),
      targetSessionKey: "agent:codex:acp:slack-dm",
    });
  });

  it("removes persisted bindings on unbind", async () => {
    await bindGenericCurrentConversation({
      conversation: {
        accountId: "default",
        channel: "googlechat",
        conversationId: "spaces/AAAAAAA",
      },
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:googlechat-room",
    });

    await unbindGenericCurrentConversationBindings({
      reason: "test cleanup",
      targetSessionKey: "agent:codex:acp:googlechat-room",
    });

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        accountId: "default",
        channel: "googlechat",
        conversationId: "spaces/AAAAAAA",
      }),
    ).toBeNull();
  });
});
