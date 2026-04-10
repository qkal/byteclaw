import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";

describe("telegram thread bindings", () => {
  let stateDirOverride: string | undefined;

  beforeEach(async () => {
    await __testing.resetTelegramThreadBindingsForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await __testing.resetTelegramThreadBindingsForTests();
    if (stateDirOverride) {
      delete process.env.OPENCLAW_STATE_DIR;
      fs.rmSync(stateDirOverride, { force: true, recursive: true });
      stateDirOverride = undefined;
    }
  });

  it("registers a telegram binding adapter and binds current conversations", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      enableSweeper: false,
      idleTimeoutMs: 30_000,
      maxAgeMs: 0,
      persist: false,
    });
    const bound = await getSessionBindingService().bind({
      conversation: {
        accountId: "work",
        channel: "telegram",
        conversationId: "-100200300:topic:77",
      },
      metadata: {
        boundBy: "user-1",
      },
      placement: "current",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
    });

    expect(bound.conversation.channel).toBe("telegram");
    expect(bound.conversation.accountId).toBe("work");
    expect(bound.conversation.conversationId).toBe("-100200300:topic:77");
    expect(bound.targetSessionKey).toBe("agent:main:subagent:child-1");
    expect(manager.getByConversationId("-100200300:topic:77")?.boundBy).toBe("user-1");
  });

  it("rejects child placement when conversationId is a bare topic ID with no group context", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      persist: false,
    });

    await expect(
      getSessionBindingService().bind({
        conversation: {
          accountId: "default",
          channel: "telegram",
          conversationId: "77",
        },
        placement: "child",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-1",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("rejects child placement when parentConversationId is also a bare topic ID", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      persist: false,
    });

    await expect(
      getSessionBindingService().bind({
        conversation: {
          accountId: "default",
          channel: "telegram",
          conversationId: "77",
          parentConversationId: "99",
        },
        placement: "child",
        targetKind: "session",
        targetSessionKey: "agent:main:acp:child-acp-1",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("shares binding state across distinct module instances", async () => {
    const bindingsA = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-a",
    );
    const bindingsB = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-b",
    );

    await bindingsA.__testing.resetTelegramThreadBindingsForTests();

    try {
      const managerA = bindingsA.createTelegramThreadBindingManager({
        accountId: "shared-runtime",
        enableSweeper: false,
        persist: false,
      });
      const managerB = bindingsB.createTelegramThreadBindingManager({
        accountId: "shared-runtime",
        enableSweeper: false,
        persist: false,
      });

      expect(managerB).toBe(managerA);

      await getSessionBindingService().bind({
        conversation: {
          accountId: "shared-runtime",
          channel: "telegram",
          conversationId: "-100200300:topic:44",
        },
        placement: "current",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-shared",
      });

      expect(
        bindingsB
          .getTelegramThreadBindingManager("shared-runtime")
          ?.getByConversationId("-100200300:topic:44")?.targetSessionKey,
      ).toBe("agent:main:subagent:child-shared");
    } finally {
      await bindingsA.__testing.resetTelegramThreadBindingsForTests();
    }
  });

  it("updates lifecycle windows by session key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      enableSweeper: false,
      persist: false,
    });

    await getSessionBindingService().bind({
      conversation: {
        accountId: "work",
        channel: "telegram",
        conversationId: "1234",
      },
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
    });
    const original = manager.listBySessionKey("agent:main:subagent:child-1")[0];
    expect(original).toBeDefined();

    const idleUpdated = setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "work",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
      targetSessionKey: "agent:main:subagent:child-1",
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    const maxAgeUpdated = setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "work",
      maxAgeMs: 6 * 60 * 60 * 1000,
      targetSessionKey: "agent:main:subagent:child-1",
    });

    expect(idleUpdated).toHaveLength(1);
    expect(idleUpdated[0]?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(maxAgeUpdated).toHaveLength(1);
    expect(maxAgeUpdated[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(maxAgeUpdated[0]?.boundAt).toBe(original?.boundAt);
    expect(maxAgeUpdated[0]?.lastActivityAt).toBe(Date.parse("2026-03-06T12:00:00.000Z"));
    expect(manager.listBySessionKey("agent:main:subagent:child-1")[0]?.maxAgeMs).toBe(
      6 * 60 * 60 * 1000,
    );
  });

  it("does not persist lifecycle updates when manager persistence is disabled", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
      accountId: "no-persist",
      enableSweeper: false,
      persist: false,
    });

    await getSessionBindingService().bind({
      conversation: {
        accountId: "no-persist",
        channel: "telegram",
        conversationId: "-100200300:topic:88",
      },
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-2",
    });

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "no-persist",
      idleTimeoutMs: 60 * 60 * 1000,
      targetSessionKey: "agent:main:subagent:child-2",
    });
    setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "no-persist",
      maxAgeMs: 2 * 60 * 60 * 1000,
      targetSessionKey: "agent:main:subagent:child-2",
    });

    const statePath = path.join(
      resolveStateDir(process.env, os.homedir),
      "telegram",
      "thread-bindings-no-persist.json",
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("persists unbinds before restart so removed bindings do not come back", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;

    createTelegramThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      persist: true,
    });

    const bound = await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "telegram",
        conversationId: "8460800771",
      },
      targetKind: "session",
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:abc123",
    });

    await getSessionBindingService().unbind({
      bindingId: bound.bindingId,
      reason: "test-detach",
    });

    await __testing.resetTelegramThreadBindingsForTests();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      persist: true,
    });

    expect(reloaded.getByConversationId("8460800771")).toBeUndefined();
  });

  it("flushes pending lifecycle update persists before test reset", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
      accountId: "persist-reset",
      enableSweeper: false,
      persist: true,
    });

    await getSessionBindingService().bind({
      conversation: {
        accountId: "persist-reset",
        channel: "telegram",
        conversationId: "-100200300:topic:99",
      },
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-3",
    });

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "persist-reset",
      idleTimeoutMs: 90_000,
      targetSessionKey: "agent:main:subagent:child-3",
    });

    await __testing.resetTelegramThreadBindingsForTests();

    const statePath = path.join(
      resolveStateDir(process.env, os.homedir),
      "telegram",
      "thread-bindings-persist-reset.json",
    );
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      bindings?: { idleTimeoutMs?: number }[];
    };
    expect(persisted.bindings?.[0]?.idleTimeoutMs).toBe(90_000);
  });
});
