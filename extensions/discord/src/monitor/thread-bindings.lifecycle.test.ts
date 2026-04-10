import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import {
  type OpenClawConfig,
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/config-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const sendMessageDiscord = vi.fn(async (_to: string, _text: string, _opts?: unknown) => ({}));
  const sendWebhookMessageDiscord = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  const restGet = vi.fn(async (..._args: unknown[]) => ({
    id: "thread-1",
    parent_id: "parent-1",
    type: 11,
  }));
  const restPost = vi.fn(async (..._args: unknown[]) => ({
    id: "wh-created",
    token: "tok-created",
  }));
  const createDiscordRestClient = vi.fn((..._args: unknown[]) => ({
    rest: {
      get: restGet,
      post: restPost,
    },
  }));
  const createThreadDiscord = vi.fn(async (..._args: unknown[]) => ({ id: "thread-created" }));
  const readAcpSessionEntry = vi.fn();
  return {
    createDiscordRestClient,
    createThreadDiscord,
    readAcpSessionEntry,
    restGet,
    restPost,
    sendMessageDiscord,
    sendWebhookMessageDiscord,
  };
});

vi.mock("../send.js", async () => {
  const actual = await vi.importActual<typeof import("../send.js")>("../send.js");
  return {
    ...actual,
    addRoleDiscord: vi.fn(),
    sendMessageDiscord: hoisted.sendMessageDiscord,
    sendWebhookMessageDiscord: hoisted.sendWebhookMessageDiscord,
  };
});

vi.mock("../send.messages.js", () => ({
  createThreadDiscord: hoisted.createThreadDiscord,
}));

const { __testing, createThreadBindingManager } = await import("./thread-bindings.manager.js");
const {
  autoBindSpawnedDiscordSubagent,
  reconcileAcpThreadBindingsOnStartup,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
  unbindThreadBindingsBySessionKey,
} = await import("./thread-bindings.lifecycle.js");
const { resolveThreadBindingInactivityExpiresAt, resolveThreadBindingMaxAgeExpiresAt } =
  await import("./thread-bindings.state.js");
const { resolveThreadBindingIntroText } = await import("./thread-bindings.messages.js");
const discordClientModule = await import("../client.js");
const discordThreadBindingApi = await import("./thread-bindings.discord-api.js");
const acpRuntime = await import("openclaw/plugin-sdk/acp-runtime");

describe("thread binding lifecycle", () => {
  beforeEach(() => {
    __testing.resetThreadBindingsForTests();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    hoisted.sendMessageDiscord.mockReset().mockResolvedValue({});
    hoisted.sendWebhookMessageDiscord.mockReset().mockResolvedValue({});
    hoisted.restGet.mockReset().mockResolvedValue({
      id: "thread-1",
      parent_id: "parent-1",
      type: 11,
    });
    hoisted.restPost.mockReset().mockResolvedValue({
      id: "wh-created",
      token: "tok-created",
    });
    hoisted.createDiscordRestClient.mockReset().mockImplementation((..._args: unknown[]) => ({
      rest: {
        get: hoisted.restGet,
        post: hoisted.restPost,
      },
    }));
    hoisted.createThreadDiscord.mockReset().mockResolvedValue({ id: "thread-created" });
    hoisted.readAcpSessionEntry.mockReset().mockReturnValue(null);
    vi.spyOn(discordClientModule, "createDiscordRestClient").mockImplementation(
      (...args) =>
        hoisted.createDiscordRestClient(...args) as unknown as ReturnType<
          typeof discordClientModule.createDiscordRestClient
        >,
    );
    vi.spyOn(discordThreadBindingApi, "createWebhookForChannel").mockImplementation(
      async (params) => {
        const { rest } = hoisted.createDiscordRestClient(
          {
            accountId: params.accountId,
            token: params.token,
          },
          params.cfg,
        );
        const created = (await rest.post("mock:channel-webhook")) as {
          id?: string;
          token?: string;
        };
        return {
          webhookId: typeof created?.id === "string" ? created.id.trim() || undefined : undefined,
          webhookToken:
            typeof created?.token === "string" ? created.token.trim() || undefined : undefined,
        };
      },
    );
    vi.spyOn(discordThreadBindingApi, "resolveChannelIdForBinding").mockImplementation(
      async (params) => {
        const explicit = params.channelId?.trim();
        if (explicit) {
          return explicit;
        }
        const { rest } = hoisted.createDiscordRestClient(
          {
            accountId: params.accountId,
            token: params.token,
          },
          params.cfg,
        );
        const channel = (await rest.get("mock:channel-resolve")) as {
          id?: string;
          type?: number;
          parent_id?: string;
          parentId?: string;
        };
        const channelId = typeof channel?.id === "string" ? channel.id.trim() : "";
        const parentId =
          typeof channel?.parent_id === "string"
            ? channel.parent_id.trim()
            : typeof channel?.parentId === "string"
              ? channel.parentId.trim()
              : "";
        const isThreadType =
          channel?.type === ChannelType.PublicThread ||
          channel?.type === ChannelType.PrivateThread ||
          channel?.type === ChannelType.AnnouncementThread;
        if (parentId && isThreadType) {
          return parentId;
        }
        return channelId || null;
      },
    );
    vi.spyOn(discordThreadBindingApi, "createThreadForBinding").mockImplementation(
      async (params) => {
        const created = await hoisted.createThreadDiscord(
          params.channelId,
          {
            autoArchiveMinutes: 60,
            name: params.threadName,
          },
          {
            accountId: params.accountId,
            cfg: params.cfg,
            token: params.token,
          },
        );
        return typeof created?.id === "string" ? created.id.trim() || null : null;
      },
    );
    vi.spyOn(discordThreadBindingApi, "maybeSendBindingMessage").mockImplementation(
      async (params) => {
        if (
          params.preferWebhook !== false &&
          params.record.webhookId &&
          params.record.webhookToken
        ) {
          await hoisted.sendWebhookMessageDiscord(params.text, {
            accountId: params.record.accountId,
            cfg: params.cfg,
            threadId: params.record.threadId,
            webhookId: params.record.webhookId,
            webhookToken: params.record.webhookToken,
          });
          return;
        }
        await hoisted.sendMessageDiscord(`channel:${params.record.threadId}`, params.text, {
          accountId: params.record.accountId,
          cfg: params.cfg,
        });
      },
    );
    vi.spyOn(acpRuntime, "readAcpSessionEntry").mockImplementation(hoisted.readAcpSessionEntry);
    vi.useRealTimers();
  });

  const createDefaultSweeperManager = () =>
    createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

  const bindDefaultThreadTarget = async (
    manager: ReturnType<typeof createThreadBindingManager>,
  ) => {
    await manager.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      threadId: "thread-1",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
  };

  const requireBinding = (
    manager: ReturnType<typeof createThreadBindingManager>,
    threadId: string,
  ) => {
    const binding = manager.getByThreadId(threadId);
    if (!binding) {
      throw new Error(`missing thread binding: ${threadId}`);
    }
    return binding;
  };

  it("includes idle and max-age details in intro text", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "main",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      label: "worker",
      maxAgeMs: 48 * 60 * 60 * 1000,
    });
    expect(intro).toContain("idle auto-unfocus after 24h inactivity");
    expect(intro).toContain("max age 48h");
  });

  it("includes cwd near the top of intro text", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "codex",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      sessionCwd: "/home/bob/clawd",
      sessionDetails: ["session ids: pending (available after the first reply)"],
    });
    expect(intro).toContain("\ncwd: /home/bob/clawd\nsession ids: pending");
  });

  it("auto-unfocuses idle-expired bindings and sends inactivity message", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
        persist: false,
      });

      const binding = await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        introText: "intro",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      expect(binding).not.toBeNull();
      hoisted.sendMessageDiscord.mockClear();
      hoisted.sendWebhookMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);
      await __testing.runThreadBindingSweepForAccount("default");

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      expect(hoisted.restGet).not.toHaveBeenCalled();
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
      expect(hoisted.sendMessageDiscord).toHaveBeenCalledTimes(1);
      const farewell = hoisted.sendMessageDiscord.mock.calls[0]?.[1] as string | undefined;
      expect(farewell).toContain("after 1m of inactivity");
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-unfocuses max-age-expired bindings and sends max-age message", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 0,
        maxAgeMs: 60_000,
        persist: false,
      });

      const binding = await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      expect(binding).not.toBeNull();
      hoisted.sendMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);
      await __testing.runThreadBindingSweepForAccount("default");

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      expect(hoisted.sendMessageDiscord).toHaveBeenCalledTimes(1);
      const farewell = hoisted.sendMessageDiscord.mock.calls[0]?.[1] as string | undefined;
      expect(farewell).toContain("max age of 1m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps binding when thread sweep probe fails transiently", async () => {
    vi.useFakeTimers();
    try {
      const manager = createDefaultSweeperManager();
      await bindDefaultThreadTarget(manager);

      hoisted.restGet.mockRejectedValueOnce(new Error("ECONNRESET"));

      await vi.advanceTimersByTimeAsync(120_000);
      await __testing.runThreadBindingSweepForAccount("default");

      expect(requireBinding(manager, "thread-1")).toMatchObject({
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unbinds when thread sweep probe reports unknown channel", async () => {
    vi.useFakeTimers();
    try {
      const manager = createDefaultSweeperManager();
      await bindDefaultThreadTarget(manager);

      hoisted.restGet.mockRejectedValueOnce({
        rawError: { code: 10_003, message: "Unknown Channel" },
        status: 404,
      });

      await vi.advanceTimersByTimeAsync(120_000);
      await __testing.runThreadBindingSweepForAccount("default");

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates idle timeout by target session key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T23:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
        persist: false,
      });

      await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });

      const boundAt = manager.getByThreadId("thread-1")?.boundAt;
      vi.setSystemTime(new Date("2026-02-20T23:15:00.000Z"));

      const updated = setThreadBindingIdleTimeoutBySessionKey({
        accountId: "default",
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        targetSessionKey: "agent:main:subagent:child",
      });

      expect(updated).toHaveLength(1);
      expect(updated[0]?.lastActivityAt).toBe(new Date("2026-02-20T23:15:00.000Z").getTime());
      expect(updated[0]?.boundAt).toBe(boundAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
          record: updated[0],
        }),
      ).toBe(new Date("2026-02-21T01:15:00.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates max age by target session key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T10:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
        persist: false,
      });

      await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
      });

      vi.setSystemTime(new Date("2026-02-20T10:30:00.000Z"));
      const updated = setThreadBindingMaxAgeBySessionKey({
        accountId: "default",
        maxAgeMs: 3 * 60 * 60 * 1000,
        targetSessionKey: "agent:main:subagent:child",
      });

      expect(updated).toHaveLength(1);
      expect(updated[0]?.boundAt).toBe(new Date("2026-02-20T10:30:00.000Z").getTime());
      expect(updated[0]?.lastActivityAt).toBe(new Date("2026-02-20T10:30:00.000Z").getTime());
      expect(
        resolveThreadBindingMaxAgeExpiresAt({
          defaultMaxAgeMs: manager.getMaxAgeMs(),
          record: updated[0],
        }),
      ).toBe(new Date("2026-02-20T13:30:00.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps binding when idle timeout is disabled per session key", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
        persist: false,
      });

      await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });

      const updated = setThreadBindingIdleTimeoutBySessionKey({
        accountId: "default",
        idleTimeoutMs: 0,
        targetSessionKey: "agent:main:subagent:child",
      });
      expect(updated).toHaveLength(1);
      expect(updated[0]?.idleTimeoutMs).toBe(0);

      await vi.advanceTimersByTimeAsync(240_000);
      await __testing.runThreadBindingSweepForAccount("default");

      expect(requireBinding(manager, "thread-1")).toMatchObject({
        idleTimeoutMs: 0,
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a binding when activity is touched during the same sweep pass", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
        persist: false,
      });

      await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:first",
        threadId: "thread-1",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:second",
        threadId: "thread-2",
        webhookId: "wh-2",
        webhookToken: "tok-2",
      });

      // Keep the first binding off the idle-expire path so the sweep performs
      // An awaited probe and gives a window for in-pass touches.
      setThreadBindingIdleTimeoutBySessionKey({
        accountId: "default",
        idleTimeoutMs: 0,
        targetSessionKey: "agent:main:subagent:first",
      });

      hoisted.restGet.mockImplementation(async (...args: unknown[]) => {
        const route = typeof args[0] === "string" ? args[0] : "";
        if (route.includes("thread-1")) {
          manager.touchThread({ persist: false, threadId: "thread-2" });
        }
        return {
          id: route.split("/").at(-1) ?? "thread-1",
          parent_id: "parent-1",
          type: 11,
        };
      });
      hoisted.sendMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);
      await __testing.runThreadBindingSweepForAccount("default");

      expect(requireBinding(manager, "thread-2")).toMatchObject({
        targetSessionKey: "agent:main:subagent:second",
        threadId: "thread-2",
      });
      expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes inactivity window when thread activity is touched", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
        persist: false,
      });

      await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
      });

      vi.setSystemTime(new Date("2026-02-20T00:00:30.000Z"));
      const touched = manager.touchThread({ persist: false, threadId: "thread-1" });
      expect(touched).not.toBeNull();

      const record = requireBinding(manager, "thread-1");
      expect(record.lastActivityAt).toBe(new Date("2026-02-20T00:00:30.000Z").getTime());
      expect(
        resolveThreadBindingInactivityExpiresAt({
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
          record,
        }),
      ).toBe(new Date("2026-02-20T00:01:30.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists touched activity timestamps across restart when persistence is enabled", async () => {
    vi.useFakeTimers();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      __testing.resetThreadBindingsForTests();
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
        persist: true,
      });

      await manager.bindTarget({
        agentId: "main",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        threadId: "thread-1",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });

      const touchedAt = new Date("2026-02-20T00:00:30.000Z").getTime();
      vi.setSystemTime(touchedAt);
      manager.touchThread({ threadId: "thread-1" });

      __testing.resetThreadBindingsForTests();
      const reloaded = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
        persist: true,
      });

      const record = requireBinding(reloaded, "thread-1");
      expect(record.lastActivityAt).toBe(touchedAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          defaultIdleTimeoutMs: reloaded.getIdleTimeoutMs(),
          record,
        }),
      ).toBe(new Date("2026-02-20T00:01:30.000Z").getTime());
    } finally {
      __testing.resetThreadBindingsForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it("reuses webhook credentials after unbind when rebinding in the same channel", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    const first = await manager.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      threadId: "thread-1",
    });
    expect(first).not.toBeNull();
    expect(hoisted.restPost).toHaveBeenCalledTimes(1);

    manager.unbindThread({
      sendFarewell: false,
      threadId: "thread-1",
    });

    const second = await manager.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-2",
      threadId: "thread-2",
    });
    expect(second).not.toBeNull();
    expect(second?.webhookId).toBe("wh-created");
    expect(second?.webhookToken).toBe("tok-created");
    expect(hoisted.restPost).toHaveBeenCalledTimes(1);
  });

  it("creates a new thread when spawning from an already bound thread", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:parent",
      threadId: "thread-1",
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-2" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      accountId: "default",
      agentId: "main",
      channel: "discord",
      childSessionKey: "agent:main:subagent:child-2",
      threadId: "thread-1",
      to: "channel:thread-1",
    });

    expect(childBinding).not.toBeNull();
    expect(hoisted.createThreadDiscord).toHaveBeenCalledTimes(1);
    expect(hoisted.createThreadDiscord).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ autoArchiveMinutes: 60 }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:parent");
    expect(manager.getByThreadId("thread-created-2")?.targetSessionKey).toBe(
      "agent:main:subagent:child-2",
    );
  });

  it("resolves parent channel when thread target is passed via to without threadId", async () => {
    createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    hoisted.restGet.mockClear();
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-lookup",
      parent_id: "parent-1",
      type: 11,
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-lookup" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      accountId: "default",
      agentId: "main",
      channel: "discord",
      childSessionKey: "agent:main:subagent:child-lookup",
      to: "channel:thread-lookup",
    });

    expect(childBinding).not.toBeNull();
    expect(childBinding?.channelId).toBe("parent-1");
    expect(hoisted.restGet).toHaveBeenCalledTimes(1);
    expect(hoisted.createThreadDiscord).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ autoArchiveMinutes: 60 }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("passes manager token when resolving parent channels for auto-bind", async () => {
    const cfg = {
      channels: { discord: { token: "tok" } },
    } as OpenClawConfig;
    createThreadBindingManager({
      accountId: "runtime",
      cfg,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
      token: "runtime-token",
    });

    hoisted.createDiscordRestClient.mockClear();
    hoisted.restGet.mockClear();
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-runtime",
      parent_id: "parent-runtime",
      type: 11,
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-runtime" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      accountId: "runtime",
      agentId: "main",
      cfg,
      channel: "discord",
      childSessionKey: "agent:main:subagent:child-runtime",
      to: "channel:thread-runtime",
    });

    expect(childBinding).not.toBeNull();
    const firstClientArgs = hoisted.createDiscordRestClient.mock.calls[0]?.[0] as
      | { accountId?: string; token?: string }
      | undefined;
    expect(firstClientArgs).toMatchObject({
      accountId: "runtime",
      token: "runtime-token",
    });
    const usedCfg = hoisted.createDiscordRestClient.mock.calls.some((call) => {
      if (call?.[1] === cfg) {
        return true;
      }
      const first = call?.[0];
      return (
        typeof first === "object" && first !== null && (first as { cfg?: unknown }).cfg === cfg
      );
    });
    expect(usedCfg).toBe(true);
  });

  it("uses the active runtime snapshot cfg for manager operations", async () => {
    const startupCfg = {
      channels: { discord: { token: "startup-token" } },
    } as OpenClawConfig;
    const refreshedCfg = {
      channels: { discord: { token: "refreshed-token" } },
    } as OpenClawConfig;
    const manager = createThreadBindingManager({
      accountId: "runtime",
      cfg: startupCfg,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
      token: "runtime-token",
    });

    setRuntimeConfigSnapshot(refreshedCfg);
    hoisted.createDiscordRestClient.mockClear();
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-runtime-cfg" });

    const bound = await manager.bindTarget({
      agentId: "main",
      channelId: "parent-runtime",
      createThread: true,
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:runtime-cfg",
    });

    expect(bound).not.toBeNull();
    const usedRefreshedCfg = hoisted.createDiscordRestClient.mock.calls.some((call) => {
      if (call?.[1] === refreshedCfg) {
        return true;
      }
      const first = call?.[0];
      return (
        typeof first === "object" &&
        first !== null &&
        (first as { cfg?: unknown }).cfg === refreshedCfg
      );
    });
    expect(usedRefreshedCfg).toBe(true);
    const usedStartupCfg = hoisted.createDiscordRestClient.mock.calls.some((call) => {
      if (call?.[1] === startupCfg) {
        return true;
      }
      const first = call?.[0];
      return (
        typeof first === "object" &&
        first !== null &&
        (first as { cfg?: unknown }).cfg === startupCfg
      );
    });
    expect(usedStartupCfg).toBe(false);
  });

  it("refreshes manager token when an existing manager is reused", async () => {
    createThreadBindingManager({
      accountId: "runtime",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
      token: "token-old",
    });
    const manager = createThreadBindingManager({
      accountId: "runtime",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
      token: "token-new",
    });

    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-token-refresh" });
    hoisted.createDiscordRestClient.mockClear();

    const bound = await manager.bindTarget({
      agentId: "main",
      channelId: "parent-runtime",
      createThread: true,
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:token-refresh",
    });

    expect(bound).not.toBeNull();
    expect(hoisted.createThreadDiscord).toHaveBeenCalledWith(
      "parent-runtime",
      expect.objectContaining({ autoArchiveMinutes: 60 }),
      expect.objectContaining({ accountId: "runtime", token: "token-new" }),
    );
    const usedTokenNew = hoisted.createDiscordRestClient.mock.calls.some(
      (call) => (call?.[0] as { token?: string } | undefined)?.token === "token-new",
    );
    expect(usedTokenNew).toBe(true);
  });

  it("binds current Discord DMs as direct conversation bindings", async () => {
    createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    hoisted.restGet.mockClear();
    hoisted.restPost.mockClear();

    const bound = await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:1177378744822943744",
      },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      placement: "current",
      targetKind: "session",
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:dm",
    });

    expect(bound).toMatchObject({
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:1177378744822943744",
        parentConversationId: "user:1177378744822943744",
      },
    });
    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "default",
        channel: "discord",
        conversationId: "user:1177378744822943744",
      }),
    ).toMatchObject({
      conversation: {
        conversationId: "user:1177378744822943744",
      },
    });
    expect(hoisted.restGet).not.toHaveBeenCalled();
    expect(hoisted.restPost).not.toHaveBeenCalled();
  });

  it("keeps overlapping thread ids isolated per account", async () => {
    const a = createThreadBindingManager({
      accountId: "a",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });
    const b = createThreadBindingManager({
      accountId: "b",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    const aBinding = await a.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:a",
      threadId: "thread-1",
    });
    const bBinding = await b.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:b",
      threadId: "thread-1",
    });

    expect(aBinding?.accountId).toBe("a");
    expect(bBinding?.accountId).toBe("b");
    expect(a.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:a");
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");

    const removedA = a.unbindBySessionKey({
      sendFarewell: false,
      targetSessionKey: "agent:main:subagent:a",
    });
    expect(removedA).toHaveLength(1);
    expect(a.getByThreadId("thread-1")).toBeUndefined();
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");
  });

  it("removes stale ACP bindings during startup reconciliation", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:healthy",
      threadId: "thread-acp-healthy",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:stale",
      threadId: "thread-acp-stale",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      threadId: "thread-subagent",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey === "agent:codex:acp:healthy") {
        return {
          acp: {
            agent: "codex",
            backend: "acpx",
            lastActivityAt: Date.now(),
            mode: "persistent",
            runtimeSessionName: "runtime:healthy",
            state: "idle",
          },
          sessionKey,
          storeSessionKey: sessionKey,
        };
      }
      return {
        acp: undefined,
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
    });

    expect(result.checked).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.staleSessionKeys).toContain("agent:codex:acp:stale");
    expect(requireBinding(manager, "thread-acp-healthy")).toMatchObject({
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:healthy",
      threadId: "thread-acp-healthy",
    });
    expect(manager.getByThreadId("thread-acp-stale")).toBeUndefined();
    expect(requireBinding(manager, "thread-subagent")).toMatchObject({
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      threadId: "thread-subagent",
    });
    expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
  });

  it("keeps ACP bindings when session store reads fail during startup reconciliation", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:uncertain",
      threadId: "thread-acp-uncertain",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockReturnValue({
      acp: undefined,
      cfg: {} as OpenClawConfig,
      entry: undefined,
      sessionKey: "agent:codex:acp:uncertain",
      storePath: "/tmp/mock-sessions.json",
      storeReadFailed: true,
      storeSessionKey: "agent:codex:acp:uncertain",
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toEqual([]);
    expect(requireBinding(manager, "thread-acp-uncertain")).toMatchObject({
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:uncertain",
      threadId: "thread-acp-uncertain",
    });
  });

  it("does not reconcile plugin-owned direct bindings as stale ACP sessions", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "codex",
      channelId: "user:1177378744822943744",
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      targetKind: "acp",
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:dm",
      threadId: "user:1177378744822943744",
    });

    hoisted.readAcpSessionEntry.mockReturnValue(null);

    const result = await reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
    });

    expect(result.checked).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toEqual([]);
    expect(manager.getByThreadId("user:1177378744822943744")).toMatchObject({
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
      },
      threadId: "user:1177378744822943744",
    });
  });

  it("removes ACP bindings when health probe marks running session as stale", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:running",
      threadId: "thread-acp-running",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now() - 5 * 60 * 1000,
        mode: "persistent",
        runtimeSessionName: "runtime:running",
        state: "running",
      },
      sessionKey: "agent:codex:acp:running",
      storeSessionKey: "agent:codex:acp:running",
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
      healthProbe: async () => ({ reason: "status-timeout-running-stale", status: "stale" }),
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.staleSessionKeys).toContain("agent:codex:acp:running");
    expect(manager.getByThreadId("thread-acp-running")).toBeUndefined();
  });

  it("keeps running ACP bindings when health probe is uncertain", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:running-uncertain",
      threadId: "thread-acp-running-uncertain",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:running-uncertain",
        state: "running",
      },
      sessionKey: "agent:codex:acp:running-uncertain",
      storeSessionKey: "agent:codex:acp:running-uncertain",
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
      healthProbe: async () => ({ reason: "status-timeout", status: "uncertain" }),
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toEqual([]);
    expect(requireBinding(manager, "thread-acp-running-uncertain")).toMatchObject({
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:running-uncertain",
      threadId: "thread-acp-running-uncertain",
    });
  });

  it("keeps ACP bindings in stored error state when no explicit stale probe verdict exists", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:error",
      threadId: "thread-acp-error",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:error",
        state: "error",
      },
      sessionKey: "agent:codex:acp:error",
      storeSessionKey: "agent:codex:acp:error",
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toEqual([]);
    expect(requireBinding(manager, "thread-acp-error")).toMatchObject({
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:error",
      threadId: "thread-acp-error",
    });
  });

  it("starts ACP health probes in parallel during startup reconciliation", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:probe-1",
      threadId: "thread-acp-probe-1",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      agentId: "codex",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:probe-2",
      threadId: "thread-acp-probe-2",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: Date.now(),
          mode: "persistent",
          runtimeSessionName: `runtime:${sessionKey}`,
          state: "running",
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });

    let resolveFirstProbe: ((value: { status: "healthy" }) => void) | undefined;
    const firstProbe = new Promise<{ status: "healthy" }>((resolve) => {
      resolveFirstProbe = resolve;
    });
    let probeCallCount = 0;
    let secondProbeStartedBeforeFirstResolved = false;

    const reconcilePromise = reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
      healthProbe: async () => {
        probeCallCount += 1;
        if (probeCallCount === 1) {
          return await firstProbe;
        }
        secondProbeStartedBeforeFirstResolved = true;
        return { status: "healthy" as const };
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    const observedParallelStart = secondProbeStartedBeforeFirstResolved;

    resolveFirstProbe?.({ status: "healthy" });
    const result = await reconcilePromise;

    expect(observedParallelStart).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.removed).toBe(0);
  });

  it("caps ACP startup health probe concurrency", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      persist: false,
    });

    for (let index = 0; index < 12; index += 1) {
      const key = `agent:codex:acp:cap-${index}`;
      await manager.bindTarget({
        agentId: "codex",
        channelId: "parent-1",
        targetKind: "acp",
        targetSessionKey: key,
        threadId: `thread-acp-cap-${index}`,
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
    }

    hoisted.readAcpSessionEntry.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: Date.now(),
          mode: "persistent",
          runtimeSessionName: `runtime:${sessionKey}`,
          state: "running",
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });

    const PROBE_LIMIT = 8;
    let probeCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirstWave: (() => void) | undefined;
    const firstWaveGate = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });

    const reconcilePromise = reconcileAcpThreadBindingsOnStartup({
      accountId: "default",
      cfg: {} as OpenClawConfig,
      healthProbe: async () => {
        probeCalls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (probeCalls <= PROBE_LIMIT) {
          await firstWaveGate;
        }
        inFlight -= 1;
        return { status: "healthy" as const };
      },
    });

    await vi.waitFor(() => {
      expect(probeCalls).toBe(PROBE_LIMIT);
    });
    expect(maxInFlight).toBe(PROBE_LIMIT);

    releaseFirstWave?.();
    const result = await reconcilePromise;
    expect(result.checked).toBe(12);
    expect(result.removed).toBe(0);
    expect(maxInFlight).toBeLessThanOrEqual(PROBE_LIMIT);
  });

  it("migrates legacy expiresAt bindings to idle/max-age semantics", () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      __testing.resetThreadBindingsForTests();
      const bindingsPath = __testing.resolveThreadBindingsPath();
      fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
      const boundAt = Date.now() - 10_000;
      const expiresAt = boundAt + 60_000;
      fs.writeFileSync(
        bindingsPath,
        JSON.stringify(
          {
            bindings: {
              "thread-legacy-active": {
                accountId: "default",
                agentId: "main",
                boundAt,
                boundBy: "system",
                channelId: "parent-1",
                expiresAt,
                targetKind: "subagent",
                targetSessionKey: "agent:main:subagent:legacy-active",
                threadId: "thread-legacy-active",
              },
              "thread-legacy-disabled": {
                accountId: "default",
                agentId: "main",
                boundAt,
                boundBy: "system",
                channelId: "parent-1",
                expiresAt: 0,
                targetKind: "subagent",
                targetSessionKey: "agent:main:subagent:legacy-disabled",
                threadId: "thread-legacy-disabled",
              },
            },
            version: 1,
          },
          null,
          2,
        ),
        "utf8",
      );

      const manager = createThreadBindingManager({
        accountId: "default",
        enableSweeper: false,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
        persist: false,
      });

      const active = manager.getByThreadId("thread-legacy-active");
      if (!active) {
        throw new Error("missing migrated legacy active thread binding");
      }
      expect(active.idleTimeoutMs).toBe(0);
      expect(active.maxAgeMs).toBe(expiresAt - boundAt);
      expect(
        resolveThreadBindingMaxAgeExpiresAt({
          defaultMaxAgeMs: manager.getMaxAgeMs(),
          record: active,
        }),
      ).toBe(expiresAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
          record: active,
        }),
      ).toBeUndefined();

      const disabled = manager.getByThreadId("thread-legacy-disabled");
      if (!disabled) {
        throw new Error("missing migrated legacy disabled thread binding");
      }
      expect(disabled.idleTimeoutMs).toBe(0);
      expect(disabled.maxAgeMs).toBe(0);
      expect(
        resolveThreadBindingMaxAgeExpiresAt({
          defaultMaxAgeMs: manager.getMaxAgeMs(),
          record: disabled,
        }),
      ).toBeUndefined();
      expect(
        resolveThreadBindingInactivityExpiresAt({
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
          record: disabled,
        }),
      ).toBeUndefined();
    } finally {
      __testing.resetThreadBindingsForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("persists unbinds even when no manager is active", () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      __testing.resetThreadBindingsForTests();
      const bindingsPath = __testing.resolveThreadBindingsPath();
      fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
      const now = Date.now();
      fs.writeFileSync(
        bindingsPath,
        JSON.stringify(
          {
            bindings: {
              "thread-1": {
                accountId: "default",
                agentId: "main",
                boundAt: now,
                boundBy: "system",
                channelId: "parent-1",
                idleTimeoutMs: 60_000,
                lastActivityAt: now,
                maxAgeMs: 0,
                targetKind: "subagent",
                targetSessionKey: "agent:main:subagent:child",
                threadId: "thread-1",
              },
            },
            version: 1,
          },
          null,
          2,
        ),
        "utf8",
      );

      const removed = unbindThreadBindingsBySessionKey({
        targetSessionKey: "agent:main:subagent:child",
      });
      expect(removed).toHaveLength(1);

      const payload = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as {
        bindings?: Record<string, unknown>;
      };
      expect(Object.keys(payload.bindings ?? {})).toEqual([]);
    } finally {
      __testing.resetThreadBindingsForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
