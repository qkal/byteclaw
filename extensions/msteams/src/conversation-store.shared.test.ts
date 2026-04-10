import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { createMSTeamsConversationStoreMemory } from "./conversation-store-memory.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

interface StoreFactory {
  name: string;
  createStore: () => Promise<MSTeamsConversationStore>;
}

const storeFactories: StoreFactory[] = [
  {
    createStore: async () => {
      const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
      return createMSTeamsConversationStoreFs({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        ttlMs: 60_000,
      });
    },
    name: "fs",
  },
  {
    createStore: async () => createMSTeamsConversationStoreMemory(),
    name: "memory",
  },
];

describe.each(storeFactories)("msteams conversation store ($name)", ({ createStore }) => {
  beforeEach(() => {
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("normalizes conversation ids consistently", async () => {
    const store = await createStore();

    await store.upsert("conv-norm;messageid=123", {
      channelId: "msteams",
      conversation: { id: "conv-norm" },
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    await expect(store.get("conv-norm")).resolves.toEqual(
      expect.objectContaining({
        conversation: { id: "conv-norm" },
      }),
    );
    await expect(store.remove("conv-norm")).resolves.toBe(true);
    await expect(store.get("conv-norm;messageid=123")).resolves.toBeNull();
  });

  it("upserts, lists, removes, and resolves users by both AAD and Bot Framework ids", async () => {
    const store = await createStore();

    await store.upsert("conv-a", {
      channelId: "msteams",
      conversation: { id: "conv-a" },
      serviceUrl: "https://service.example.com",
      user: { aadObjectId: "aad-a", id: "user-a", name: "Alice" },
    });

    await store.upsert("conv-b", {
      channelId: "msteams",
      conversation: { id: "conv-b" },
      serviceUrl: "https://service.example.com",
      user: { aadObjectId: "aad-b", id: "user-b", name: "Bob" },
    });

    await expect(store.get("conv-a")).resolves.toEqual({
      channelId: "msteams",
      conversation: { id: "conv-a" },
      lastSeenAt: expect.any(String),
      serviceUrl: "https://service.example.com",
      user: { aadObjectId: "aad-a", id: "user-a", name: "Alice" },
    });

    await expect(store.list()).resolves.toEqual([
      {
        conversationId: "conv-a",
        reference: {
          channelId: "msteams",
          conversation: { id: "conv-a" },
          lastSeenAt: expect.any(String),
          serviceUrl: "https://service.example.com",
          user: { aadObjectId: "aad-a", id: "user-a", name: "Alice" },
        },
      },
      {
        conversationId: "conv-b",
        reference: {
          channelId: "msteams",
          conversation: { id: "conv-b" },
          lastSeenAt: expect.any(String),
          serviceUrl: "https://service.example.com",
          user: { aadObjectId: "aad-b", id: "user-b", name: "Bob" },
        },
      },
    ]);

    await expect(store.findPreferredDmByUserId("  aad-b  ")).resolves.toEqual({
      conversationId: "conv-b",
      reference: {
        channelId: "msteams",
        conversation: { id: "conv-b" },
        lastSeenAt: expect.any(String),
        serviceUrl: "https://service.example.com",
        user: { aadObjectId: "aad-b", id: "user-b", name: "Bob" },
      },
    });
    await expect(store.findPreferredDmByUserId("user-a")).resolves.toEqual({
      conversationId: "conv-a",
      reference: {
        channelId: "msteams",
        conversation: { id: "conv-a" },
        lastSeenAt: expect.any(String),
        serviceUrl: "https://service.example.com",
        user: { aadObjectId: "aad-a", id: "user-a", name: "Alice" },
      },
    });
    await expect(store.findByUserId("user-a")).resolves.toEqual(
      await store.findPreferredDmByUserId("user-a"),
    );
    await expect(store.findPreferredDmByUserId("   ")).resolves.toBeNull();

    await expect(store.remove("conv-a")).resolves.toBe(true);
    await expect(store.get("conv-a")).resolves.toBeNull();
    await expect(store.remove("missing")).resolves.toBe(false);
  });

  it("preserves existing timezone when upsert omits timezone", async () => {
    const store = await createStore();

    await store.upsert("conv-tz", {
      channelId: "msteams",
      conversation: { id: "conv-tz" },
      serviceUrl: "https://service.example.com",
      timezone: "Europe/London",
      user: { id: "u1" },
    });

    await store.upsert("conv-tz", {
      channelId: "msteams",
      conversation: { id: "conv-tz" },
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    await expect(store.get("conv-tz")).resolves.toMatchObject({
      timezone: "Europe/London",
    });
  });

  it("preserves graphChatId across upserts that omit it", async () => {
    const store = await createStore();

    await store.upsert("conv-graph", {
      channelId: "msteams",
      conversation: { conversationType: "personal", id: "conv-graph" },
      graphChatId: "19:resolved-chat-id@unq.gbl.spaces",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    // Second upsert without graphChatId (normal activity-based upsert)
    await store.upsert("conv-graph", {
      channelId: "msteams",
      conversation: { conversationType: "personal", id: "conv-graph" },
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    await expect(store.get("conv-graph")).resolves.toMatchObject({
      graphChatId: "19:resolved-chat-id@unq.gbl.spaces",
    });
  });

  it("prefers the freshest personal conversation for repeated upserts of the same user", async () => {
    const store = await createStore();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-25T20:00:00.000Z"));
      await store.upsert("dm-old", {
        channelId: "msteams",
        conversation: { conversationType: "personal", id: "dm-old" },
        serviceUrl: "https://service.example.com",
        user: { aadObjectId: "aad-shared", id: "user-shared-old", name: "Old DM" },
      });

      vi.setSystemTime(new Date("2026-03-25T20:30:00.000Z"));
      await store.upsert("group-shared", {
        channelId: "msteams",
        conversation: { conversationType: "groupChat", id: "group-shared" },
        serviceUrl: "https://service.example.com",
        user: { aadObjectId: "aad-shared", id: "user-shared-group", name: "Group" },
      });

      vi.setSystemTime(new Date("2026-03-25T21:00:00.000Z"));
      await store.upsert("dm-new", {
        channelId: "msteams",
        conversation: { conversationType: "personal", id: "dm-new" },
        serviceUrl: "https://service.example.com",
        user: { aadObjectId: "aad-shared", id: "user-shared-new", name: "New DM" },
      });

      await expect(store.findPreferredDmByUserId("aad-shared")).resolves.toEqual({
        conversationId: "dm-new",
        reference: {
          channelId: "msteams",
          conversation: { conversationType: "personal", id: "dm-new" },
          lastSeenAt: "2026-03-25T21:00:00.000Z",
          serviceUrl: "https://service.example.com",
          user: { aadObjectId: "aad-shared", id: "user-shared-new", name: "New DM" },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
