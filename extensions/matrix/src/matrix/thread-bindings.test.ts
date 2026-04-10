import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __testing, getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../runtime.js";
import {
  resolveMatrixStateFilePath,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./client/storage.js";
import type { MatrixAuth, MatrixStoragePaths } from "./client/types.js";
import {
  createMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (_to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$reply" : "$root",
    roomId: "!room:example",
  })),
);
const actualRename = fs.rename.bind(fs);
const renameMock = vi.spyOn(fs, "rename");

vi.mock("./send.js", () => ({
    sendMessageMatrix: sendMessageMatrixMock,
  }));

describe("matrix thread bindings", () => {
  let stateDir: string;
  const auth = {
    accessToken: "token",
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
  } as const;
  const accountId = "ops";
  const idleTimeoutMs = 24 * 60 * 60 * 1000;
  const matrixClient = {} as never;

  function resetThreadBindingAdapters() {
    __testing.resetSessionBindingAdaptersForTests();
    resetMatrixThreadBindingsForTests();
  }

  function currentThreadConversation(params?: {
    conversationId?: string;
    parentConversationId?: string;
  }) {
    return {
      accountId,
      channel: "matrix" as const,
      conversationId: params?.conversationId ?? "$thread",
      parentConversationId: params?.parentConversationId ?? "!room:example",
    };
  }

  function createBindingManager(
    params: {
      auth?: MatrixAuth;
      stateDir?: string;
      idleTimeoutMs?: number;
      maxAgeMs?: number;
      enableSweeper?: boolean;
      logVerboseMessage?: (message: string) => void;
    } = {},
  ) {
    return createMatrixThreadBindingManager({
      accountId,
      auth: params.auth ?? auth,
      client: matrixClient,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      idleTimeoutMs: params.idleTimeoutMs ?? idleTimeoutMs,
      maxAgeMs: params.maxAgeMs ?? 0,
      enableSweeper: params.enableSweeper ?? false,
      ...(params.logVerboseMessage ? { logVerboseMessage: params.logVerboseMessage } : {}),
    });
  }

  async function createStaticThreadBindingManager() {
    return createBindingManager();
  }

  async function bindCurrentThread(params?: {
    targetSessionKey?: string;
    conversationId?: string;
    parentConversationId?: string;
    metadata?: { introText?: string };
  }) {
    return getSessionBindingService().bind({
      conversation: currentThreadConversation({
        conversationId: params?.conversationId,
        parentConversationId: params?.parentConversationId,
      }),
      placement: "current",
      targetKind: "subagent",
      targetSessionKey: params?.targetSessionKey ?? "agent:ops:subagent:child",
      ...(params?.metadata ? { metadata: params.metadata } : {}),
    });
  }

  function resolveBindingsFilePath(customStateDir?: string) {
    return resolveMatrixStateFilePath({
      auth,
      env: process.env,
      ...(customStateDir ? { stateDir: customStateDir } : {}),
      filename: "thread-bindings.json",
    });
  }

  function writeAuthStorageMeta(authForMeta: MatrixAuth, storagePaths: MatrixStoragePaths) {
    writeStorageMeta({
      accountId: authForMeta.accountId,
      deviceId: authForMeta.deviceId ?? null,
      homeserver: authForMeta.homeserver,
      storagePaths,
      userId: authForMeta.userId,
    });
  }

  async function readPersistedLastActivityAt(bindingsPath: string) {
    const raw = await fs.readFile(bindingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      bindings?: { lastActivityAt?: number }[];
    };
    return parsed.bindings?.[0]?.lastActivityAt;
  }

  async function expectPersistedThreadBinding(
    bindingsPath: string,
    expected: {
      conversationId: string;
      targetSessionKey: string;
      parentConversationId?: string;
    },
  ) {
    await vi.waitFor(async () => {
      const persistedRaw = await fs.readFile(bindingsPath, "utf8");
      expect(JSON.parse(persistedRaw)).toMatchObject({
        bindings: [
          expect.objectContaining({
            conversationId: expected.conversationId,
            parentConversationId: expected.parentConversationId ?? "!room:example",
            targetSessionKey: expected.targetSessionKey,
          }),
        ],
        version: 1,
      });
    });
  }

  beforeEach(() => {
    stateDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "matrix-thread-bindings-"));
    resetThreadBindingAdapters();
    sendMessageMatrixMock.mockClear();
    renameMock.mockReset();
    renameMock.mockImplementation(actualRename);
    setMatrixRuntime({
      state: {
        resolveStateDir: () => stateDir,
      },
    } as PluginRuntime);
  });

  it("creates child Matrix thread bindings from a top-level room context", async () => {
    await createMatrixThreadBindingManager({
      accountId,
      auth,
      client: matrixClient,
      enableSweeper: false,
      idleTimeoutMs,
      maxAgeMs: 0,
    });

    const binding = await getSessionBindingService().bind({
      conversation: {
        accountId: "ops",
        channel: "matrix",
        conversationId: "!room:example",
      },
      metadata: {
        introText: "intro root",
      },
      placement: "child",
      targetKind: "subagent",
      targetSessionKey: "agent:ops:subagent:child",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith("room:!room:example", "intro root", {
      accountId: "ops",
      client: {},
    });
    expect(binding.conversation).toEqual({
      accountId: "ops",
      channel: "matrix",
      conversationId: "$root",
      parentConversationId: "!room:example",
    });
  });

  it("posts intro messages inside existing Matrix threads for current placement", async () => {
    await createStaticThreadBindingManager();

    const binding = await bindCurrentThread({
      metadata: {
        introText: "intro thread",
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith("room:!room:example", "intro thread", {
      accountId: "ops",
      client: {},
      threadId: "$thread",
    });
    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "ops",
        channel: "matrix",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toMatchObject({
      bindingId: binding.bindingId,
      targetSessionKey: "agent:ops:subagent:child",
    });
  });

  it("expires idle bindings via the sweeper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    try {
      await createMatrixThreadBindingManager({
        accountId: "ops",
        auth,
        client: {} as never,
        idleTimeoutMs: 1000,
        maxAgeMs: 0,
      });

      await getSessionBindingService().bind({
        conversation: {
          accountId: "ops",
          channel: "matrix",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        metadata: {
          introText: "intro thread",
        },
        placement: "current",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:child",
      });

      sendMessageMatrixMock.mockClear();
      await vi.advanceTimersByTimeAsync(61_000);
      await Promise.resolve();

      expect(
        getSessionBindingService().resolveByConversation({
          accountId: "ops",
          channel: "matrix",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists expired bindings after a sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    try {
      await createMatrixThreadBindingManager({
        accountId: "ops",
        auth,
        client: {} as never,
        idleTimeoutMs: 1000,
        maxAgeMs: 0,
      });

      await getSessionBindingService().bind({
        conversation: {
          accountId: "ops",
          channel: "matrix",
          conversationId: "$thread-1",
          parentConversationId: "!room:example",
        },
        placement: "current",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:first",
      });
      await getSessionBindingService().bind({
        conversation: {
          accountId: "ops",
          channel: "matrix",
          conversationId: "$thread-2",
          parentConversationId: "!room:example",
        },
        placement: "current",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:second",
      });

      await vi.advanceTimersByTimeAsync(61_000);
      await Promise.resolve();

      await vi.waitFor(async () => {
        const persistedRaw = await fs.readFile(resolveBindingsFilePath(), "utf8");
        expect(JSON.parse(persistedRaw)).toMatchObject({
          bindings: [],
          version: 1,
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs and survives sweeper persistence failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    const logVerboseMessage = vi.fn();
    try {
      await createMatrixThreadBindingManager({
        accountId: "ops",
        auth,
        client: {} as never,
        idleTimeoutMs: 1000,
        logVerboseMessage,
        maxAgeMs: 0,
      });

      await getSessionBindingService().bind({
        conversation: {
          accountId: "ops",
          channel: "matrix",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        placement: "current",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:child",
      });

      renameMock.mockRejectedValueOnce(new Error("disk full"));
      await vi.advanceTimersByTimeAsync(61_000);
      await Promise.resolve();

      await vi.waitFor(() => {
        expect(
          logVerboseMessage.mock.calls.some(
            ([message]) =>
              typeof message === "string" &&
              message.includes("failed auto-unbinding expired bindings"),
          ),
        ).toBe(true);
      });

      await vi.waitFor(() => {
        expect(logVerboseMessage).toHaveBeenCalledWith(
          expect.stringContaining("matrix: auto-unbinding $thread due to idle-expired"),
        );
      });

      expect(
        getSessionBindingService().resolveByConversation({
          accountId: "ops",
          channel: "matrix",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends threaded farewell messages when bindings are unbound", async () => {
    await createMatrixThreadBindingManager({
      accountId: "ops",
      auth,
      client: {} as never,
      enableSweeper: false,
      idleTimeoutMs: 1000,
      maxAgeMs: 0,
    });

    const binding = await getSessionBindingService().bind({
      conversation: {
        accountId: "ops",
        channel: "matrix",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      },
      metadata: {
        introText: "intro thread",
      },
      placement: "current",
      targetKind: "subagent",
      targetSessionKey: "agent:ops:subagent:child",
    });

    sendMessageMatrixMock.mockClear();
    await getSessionBindingService().unbind({
      bindingId: binding.bindingId,
      reason: "idle-expired",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:!room:example",
      expect.stringContaining("Session ended automatically"),
      expect.objectContaining({
        accountId: "ops",
        threadId: "$thread",
      }),
    );
  });

  it("does not reload persisted bindings after the Matrix access token changes while deviceId is unknown", async () => {
    const initialAuth = {
      ...auth,
      accessToken: "token-old",
    };
    const rotatedAuth = {
      ...auth,
      accessToken: "token-new",
    };

    const initialManager = await createBindingManager({ auth: initialAuth });

    await bindCurrentThread();
    const initialStoragePaths = resolveMatrixStoragePaths({
      ...initialAuth,
      env: process.env,
    });
    writeAuthStorageMeta(initialAuth, initialStoragePaths);

    initialManager.stop();
    resetThreadBindingAdapters();

    await createBindingManager({ auth: rotatedAuth });

    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "ops",
        channel: "matrix",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBeNull();

    const initialBindingsPath = path.join(initialStoragePaths.rootDir, "thread-bindings.json");
    const rotatedBindingsPath = path.join(
      resolveMatrixStoragePaths({
        ...rotatedAuth,
        env: process.env,
      }).rootDir,
      "thread-bindings.json",
    );
    expect(rotatedBindingsPath).not.toBe(initialBindingsPath);
  });

  it("reloads persisted bindings after the Matrix access token changes when deviceId is known", async () => {
    const initialAuth = {
      ...auth,
      accessToken: "token-old",
      deviceId: "DEVICE123",
    };
    const rotatedAuth = {
      ...auth,
      accessToken: "token-new",
      deviceId: "DEVICE123",
    };

    const initialManager = await createBindingManager({ auth: initialAuth });

    await bindCurrentThread();
    const initialStoragePaths = resolveMatrixStoragePaths({
      ...initialAuth,
      env: process.env,
    });
    writeAuthStorageMeta(initialAuth, initialStoragePaths);
    const initialBindingsPath = path.join(initialStoragePaths.rootDir, "thread-bindings.json");
    await expectPersistedThreadBinding(initialBindingsPath, {
      conversationId: "$thread",
      targetSessionKey: "agent:ops:subagent:child",
    });

    initialManager.stop();
    resetThreadBindingAdapters();

    await createBindingManager({ auth: rotatedAuth });

    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "ops",
        channel: "matrix",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toMatchObject({
      targetSessionKey: "agent:ops:subagent:child",
    });

    const rotatedBindingsPath = path.join(
      resolveMatrixStoragePaths({
        ...rotatedAuth,
        env: process.env,
      }).rootDir,
      "thread-bindings.json",
    );
    expect(rotatedBindingsPath).toBe(initialBindingsPath);
  });

  it("replaces reused account managers when the bindings stateDir changes", async () => {
    const initialStateDir = stateDir;
    const replacementStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "matrix-thread-bindings-replacement-"),
    );

    const initialManager = await createBindingManager({
      stateDir: initialStateDir,
    });

    await bindCurrentThread();

    const replacementManager = await createBindingManager({
      stateDir: replacementStateDir,
    });

    expect(replacementManager).not.toBe(initialManager);
    expect(replacementManager.listBindings()).toEqual([]);
    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "ops",
        channel: "matrix",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBeNull();

    await bindCurrentThread({
      conversationId: "$thread-2",
      targetSessionKey: "agent:ops:subagent:replacement",
    });

    await expectPersistedThreadBinding(resolveBindingsFilePath(replacementStateDir), {
      conversationId: "$thread-2",
      targetSessionKey: "agent:ops:subagent:replacement",
    });
    await expectPersistedThreadBinding(resolveBindingsFilePath(initialStateDir), {
      conversationId: "$thread",
      targetSessionKey: "agent:ops:subagent:child",
    });
  });

  it("updates lifecycle windows by session key and refreshes activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    try {
      const manager = await createMatrixThreadBindingManager({
        accountId: "ops",
        auth,
        client: {} as never,
        enableSweeper: false,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
      });

      await getSessionBindingService().bind({
        conversation: {
          accountId: "ops",
          channel: "matrix",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        placement: "current",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:child",
      });
      const original = manager.listBySessionKey("agent:ops:subagent:child")[0];
      expect(original).toBeDefined();

      const idleUpdated = setMatrixThreadBindingIdleTimeoutBySessionKey({
        accountId: "ops",
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        targetSessionKey: "agent:ops:subagent:child",
      });
      vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
      const maxAgeUpdated = setMatrixThreadBindingMaxAgeBySessionKey({
        accountId: "ops",
        maxAgeMs: 6 * 60 * 60 * 1000,
        targetSessionKey: "agent:ops:subagent:child",
      });

      expect(idleUpdated).toHaveLength(1);
      expect(idleUpdated[0]?.metadata?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
      expect(maxAgeUpdated).toHaveLength(1);
      expect(maxAgeUpdated[0]?.metadata?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
      expect(maxAgeUpdated[0]?.boundAt).toBe(original?.boundAt);
      expect(maxAgeUpdated[0]?.metadata?.lastActivityAt).toBe(
        Date.parse("2026-03-06T12:00:00.000Z"),
      );
      expect(manager.listBySessionKey("agent:ops:subagent:child")[0]?.maxAgeMs).toBe(
        6 * 60 * 60 * 1000,
      );
      expect(manager.listBySessionKey("agent:ops:subagent:child")[0]?.lastActivityAt).toBe(
        Date.parse("2026-03-06T12:00:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the latest touched activity only after the debounce window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    try {
      await createStaticThreadBindingManager();
      const binding = await bindCurrentThread();

      const bindingsPath = resolveBindingsFilePath();
      const originalLastActivityAt = await readPersistedLastActivityAt(bindingsPath);
      const firstTouchedAt = Date.parse("2026-03-06T10:05:00.000Z");
      const secondTouchedAt = Date.parse("2026-03-06T10:10:00.000Z");

      getSessionBindingService().touch(binding.bindingId, firstTouchedAt);
      getSessionBindingService().touch(binding.bindingId, secondTouchedAt);

      await vi.advanceTimersByTimeAsync(29_000);
      expect(await readPersistedLastActivityAt(bindingsPath)).toBe(originalLastActivityAt);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(async () => {
        expect(await readPersistedLastActivityAt(bindingsPath)).toBe(secondTouchedAt);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending touch persistence on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    try {
      const manager = await createStaticThreadBindingManager();
      const binding = await bindCurrentThread();
      const touchedAt = Date.parse("2026-03-06T12:00:00.000Z");
      getSessionBindingService().touch(binding.bindingId, touchedAt);

      manager.stop();
      vi.useRealTimers();

      const bindingsPath = resolveBindingsFilePath();
      await vi.waitFor(async () => {
        expect(await readPersistedLastActivityAt(bindingsPath)).toBe(touchedAt);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
