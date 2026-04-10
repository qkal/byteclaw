import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationRef,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const tempRoot = makeTrackedTempDir("openclaw-plugin-binding", tempDirs);
const approvalsPath = path.join(tempRoot, "plugin-binding-approvals.json");

const sessionBindingState = vi.hoisted(() => {
  const records = new Map<string, SessionBindingRecord>();
  let nextId = 1;

  function normalizeRef(ref: ConversationRef): ConversationRef {
    return {
      accountId: ref.accountId.trim() || "default",
      channel: ref.channel.trim().toLowerCase(),
      conversationId: ref.conversationId.trim(),
      parentConversationId: ref.parentConversationId?.trim() || undefined,
    };
  }

  function toKey(ref: ConversationRef): string {
    const normalized = normalizeRef(ref);
    return JSON.stringify(normalized);
  }

  return {
    bind: vi.fn(
      async (input: {
        targetSessionKey: string;
        targetKind: "session" | "subagent";
        conversation: ConversationRef;
        metadata?: Record<string, unknown>;
      }) => {
        const normalized = normalizeRef(input.conversation);
        const record: SessionBindingRecord = {
          bindingId: `binding-${nextId++}`,
          boundAt: Date.now(),
          conversation: normalized,
          metadata: input.metadata,
          status: "active",
          targetKind: input.targetKind,
          targetSessionKey: input.targetSessionKey,
        };
        records.set(toKey(normalized), record);
        return record;
      },
    ),
    records,
    reset() {
      records.clear();
      nextId = 1;
      this.bind.mockClear();
      this.resolveByConversation.mockClear();
      this.touch.mockClear();
      this.unbind.mockClear();
    },
    resolveByConversation: vi.fn((ref: ConversationRef) => records.get(toKey(ref)) ?? null),
    setRecord(record: SessionBindingRecord) {
      records.set(toKey(record.conversation), record);
    },
    touch: vi.fn(),
    unbind: vi.fn(async (input: { bindingId?: string }) => {
      const removed: SessionBindingRecord[] = [];
      for (const [key, record] of records.entries()) {
        if (record.bindingId !== input.bindingId) {
          continue;
        }
        removed.push(record);
        records.delete(key);
      }
      return removed;
    }),
  };
});

const pluginRuntimeState = vi.hoisted(
  () =>
    ({
      // The runtime mock is initialized before imports; beforeEach installs the real shared stub.
      registry: null as unknown as PluginRegistry,
    }) satisfies { registry: PluginRegistry },
);

vi.mock("../infra/home-dir.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/home-dir.js")>("../infra/home-dir.js");
  return {
    ...actual,
    expandHomePrefix: (value: string) => {
      if (value === "~/.openclaw/plugin-binding-approvals.json") {
        return approvalsPath;
      }
      return actual.expandHomePrefix(value);
    },
  };
});

vi.mock("./runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  return {
    ...actual,
    getActivePluginChannelRegistry: () => pluginRuntimeState.registry,
    getActivePluginRegistry: () => pluginRuntimeState.registry,
    setActivePluginRegistry: (registry: PluginRegistry) => {
      pluginRuntimeState.registry = registry;
    },
  };
});

let __testing: typeof import("./conversation-binding.js").__testing;
let buildPluginBindingApprovalCustomId: typeof import("./conversation-binding.js").buildPluginBindingApprovalCustomId;
let detachPluginConversationBinding: typeof import("./conversation-binding.js").detachPluginConversationBinding;
let getCurrentPluginConversationBinding: typeof import("./conversation-binding.js").getCurrentPluginConversationBinding;
let parsePluginBindingApprovalCustomId: typeof import("./conversation-binding.js").parsePluginBindingApprovalCustomId;
let requestPluginConversationBinding: typeof import("./conversation-binding.js").requestPluginConversationBinding;
let resolvePluginConversationBindingApproval: typeof import("./conversation-binding.js").resolvePluginConversationBindingApproval;
let registerSessionBindingAdapter: typeof import("../infra/outbound/session-binding-service.js").registerSessionBindingAdapter;
let unregisterSessionBindingAdapter: typeof import("../infra/outbound/session-binding-service.js").unregisterSessionBindingAdapter;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

type PluginBindingRequest = Awaited<ReturnType<typeof requestPluginConversationBinding>>;
type PluginBindingRequestInput = Parameters<typeof requestPluginConversationBinding>[0];
type PluginBindingDecision = Parameters<
  typeof resolvePluginConversationBindingApproval
>[0]["decision"];
type ConversationBindingModule = typeof import("./conversation-binding.js");

const conversationBindingModuleUrl = new URL("conversation-binding.ts", import.meta.url).href;

async function importConversationBindingModule(
  cacheBust: string,
): Promise<ConversationBindingModule> {
  return (await import(
    `${conversationBindingModuleUrl}?t=${cacheBust}`
  )) as ConversationBindingModule;
}

function createAdapter(channel: string, accountId: string): SessionBindingAdapter {
  return {
    accountId,
    bind: sessionBindingState.bind,
    capabilities: {
      bindSupported: true,
      placements: ["current", "child"],
      unbindSupported: true,
    },
    channel,
    listBySession: () => [],
    resolveByConversation: sessionBindingState.resolveByConversation,
    touch: sessionBindingState.touch,
    unbind: sessionBindingState.unbind,
  };
}

afterAll(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function createDiscordCodexBindRequest(
  conversationId: string,
  summary: string,
  accountId = "isolated",
): PluginBindingRequestInput {
  return {
    binding: { summary },
    conversation: {
      accountId,
      channel: "discord",
      conversationId,
    },
    pluginId: "codex",
    pluginName: "Codex App Server",
    pluginRoot: "/plugins/codex-a",
    requestedBySenderId: "user-1",
  };
}

function createTelegramCodexBindRequest(
  conversationId: string,
  threadId: string,
  summary: string,
  pluginRoot = "/plugins/codex-a",
): PluginBindingRequestInput {
  return {
    binding: { summary },
    conversation: {
      accountId: "default",
      channel: "telegram",
      conversationId,
      parentConversationId: "-10099",
      threadId,
    },
    pluginId: "codex",
    pluginName: "Codex App Server",
    pluginRoot,
    requestedBySenderId: "user-1",
  };
}

function createCodexBindRequest(params: {
  channel: "discord" | "telegram";
  accountId: string;
  conversationId: string;
  summary: string;
  pluginRoot?: string;
  pluginId?: string;
  parentConversationId?: string;
  threadId?: string;
  detachHint?: string;
}) {
  return {
    binding: {
      summary: params.summary,
      ...(params.detachHint ? { detachHint: params.detachHint } : {}),
    },
    conversation: {
      accountId: params.accountId,
      channel: params.channel,
      conversationId: params.conversationId,
      ...(params.parentConversationId ? { parentConversationId: params.parentConversationId } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
    },
    pluginId: params.pluginId ?? "codex",
    pluginName: "Codex App Server",
    pluginRoot: params.pluginRoot ?? "/plugins/codex-a",
    requestedBySenderId: "user-1",
  } satisfies PluginBindingRequestInput;
}

async function requestPendingBinding(
  input: PluginBindingRequestInput,
  requestBinding = requestPluginConversationBinding,
) {
  const request = await requestBinding(input);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }
  return request;
}

async function approveBindingRequest(
  approvalId: string,
  decision: PluginBindingDecision,
  resolveApproval = resolvePluginConversationBindingApproval,
) {
  return await resolveApproval({
    approvalId,
    decision,
    senderId: "user-1",
  });
}

async function importDuplicateConversationBindingModules() {
  const first = await importConversationBindingModule(`first-${Date.now()}`);
  const second = await importConversationBindingModule(`second-${Date.now()}`);
  first.__testing.reset();
  return { first, second };
}

async function resolveRequestedBinding(request: PluginBindingRequest) {
  expect(["pending", "bound"]).toContain(request.status);
  if (request.status === "pending") {
    const approved = await approveBindingRequest(request.approvalId, "allow-once");
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") {
      throw new Error("expected approved bind result");
    }
    return approved.binding;
  }
  if (request.status === "bound") {
    return request.binding;
  }
  throw new Error("expected pending or bound bind result");
}

async function requestResolvedBinding(input: PluginBindingRequestInput) {
  return await resolveRequestedBinding(await requestPluginConversationBinding(input));
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createResolvedHandlerRegistry(params: {
  pluginRoot: string;
  handler: (input: unknown) => Promise<void>;
}) {
  const registry = createEmptyPluginRegistry();
  registry.conversationBindingResolvedHandlers.push({
    handler: params.handler,
    pluginId: "codex",
    pluginRoot: params.pluginRoot,
    rootDir: params.pluginRoot,
    source: `${params.pluginRoot}/index.ts`,
  });
  setActivePluginRegistry(registry);
  return registry;
}

async function expectResolutionCallback(params: {
  pluginRoot: string;
  requestInput: PluginBindingRequestInput;
  decision: PluginBindingDecision;
  expectedStatus: "approved" | "denied";
  expectedCallback: unknown;
}) {
  const onResolved = vi.fn(async () => undefined);
  createResolvedHandlerRegistry({
    handler: onResolved,
    pluginRoot: params.pluginRoot,
  });

  const request = await requestPluginConversationBinding(params.requestInput);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }

  const result = await resolvePluginConversationBindingApproval({
    approvalId: request.approvalId,
    decision: params.decision,
    senderId: "user-1",
  });

  expect(result.status).toBe(params.expectedStatus);
  await flushMicrotasks();
  expect(onResolved).toHaveBeenCalledWith(params.expectedCallback);
}

async function expectResolutionDoesNotWait(params: {
  pluginRoot: string;
  requestInput: PluginBindingRequestInput;
  decision: PluginBindingDecision;
  expectedStatus: "approved" | "denied";
}) {
  const callbackGate = createDeferredVoid();
  const onResolved = vi.fn(async () => callbackGate.promise);
  createResolvedHandlerRegistry({
    handler: onResolved,
    pluginRoot: params.pluginRoot,
  });

  const request = await requestPluginConversationBinding(params.requestInput);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }

  let settled = false;
  const resolutionPromise = resolvePluginConversationBindingApproval({
    approvalId: request.approvalId,
    decision: params.decision,
    senderId: "user-1",
  }).then((result) => {
    settled = true;
    return result;
  });

  await flushMicrotasks();

  expect(settled).toBe(true);
  expect(onResolved).toHaveBeenCalledTimes(1);

  callbackGate.resolve();
  const result = await resolutionPromise;
  expect(result.status).toBe(params.expectedStatus);
}

describe("plugin conversation binding approvals", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../infra/home-dir.js", async () => {
      const actual =
        await vi.importActual<typeof import("../infra/home-dir.js")>("../infra/home-dir.js");
      return {
        ...actual,
        expandHomePrefix: (value: string) => {
          if (value === "~/.openclaw/plugin-binding-approvals.json") {
            return approvalsPath;
          }
          return actual.expandHomePrefix(value);
        },
      };
    });
    vi.doMock("./runtime.js", async () => {
      const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
      return {
        ...actual,
        getActivePluginChannelRegistry: () => pluginRuntimeState.registry,
        getActivePluginRegistry: () => pluginRuntimeState.registry,
        setActivePluginRegistry: (registry: PluginRegistry) => {
          pluginRuntimeState.registry = registry;
        },
      };
    });
    ({
      __testing,
      buildPluginBindingApprovalCustomId,
      detachPluginConversationBinding,
      getCurrentPluginConversationBinding,
      parsePluginBindingApprovalCustomId,
      requestPluginConversationBinding,
      resolvePluginConversationBindingApproval,
    } = await import("./conversation-binding.js"));
    ({ registerSessionBindingAdapter, unregisterSessionBindingAdapter } =
      await import("../infra/outbound/session-binding-service.js"));
    ({ setActivePluginRegistry } = await import("./runtime.js"));
    sessionBindingState.reset();
    __testing.reset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    fs.rmSync(approvalsPath, { force: true });
    unregisterSessionBindingAdapter({ accountId: "default", channel: "discord" });
    unregisterSessionBindingAdapter({ accountId: "work", channel: "discord" });
    unregisterSessionBindingAdapter({ accountId: "isolated", channel: "discord" });
    unregisterSessionBindingAdapter({ accountId: "default", channel: "telegram" });
    registerSessionBindingAdapter(createAdapter("discord", "default"));
    registerSessionBindingAdapter(createAdapter("discord", "work"));
    registerSessionBindingAdapter(createAdapter("discord", "isolated"));
    registerSessionBindingAdapter(createAdapter("telegram", "default"));
  });

  it("keeps Telegram bind approval callback_data within Telegram's limit", () => {
    const allowOnce = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-once");
    const allowAlways = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-always");
    const deny = buildPluginBindingApprovalCustomId("abcdefghijkl", "deny");

    expect(Buffer.byteLength(allowOnce, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(allowAlways, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(deny, "utf8")).toBeLessThanOrEqual(64);
    expect(parsePluginBindingApprovalCustomId(allowAlways)).toEqual({
      approvalId: "abcdefghijkl",
      decision: "allow-always",
    });
  });

  it("requires a fresh approval again after allow-once is consumed", async () => {
    const firstRequest = await requestPendingBinding(
      createDiscordCodexBindRequest("channel:1", "Bind this conversation to Codex thread 123."),
    );
    const approved = await approveBindingRequest(firstRequest.approvalId, "allow-once");

    expect(approved.status).toBe("approved");

    const secondRequest = await requestPluginConversationBinding(
      createDiscordCodexBindRequest("channel:2", "Bind this conversation to Codex thread 456."),
    );

    expect(secondRequest.status).toBe("pending");
  });

  it("persists always-allow by plugin root plus channel/account only", async () => {
    const firstRequest = await requestPendingBinding(
      createDiscordCodexBindRequest("channel:1", "Bind this conversation to Codex thread 123."),
    );
    const approved = await approveBindingRequest(firstRequest.approvalId, "allow-always");

    expect(approved.status).toBe("approved");

    const sameScope = await requestPluginConversationBinding(
      createDiscordCodexBindRequest("channel:2", "Bind this conversation to Codex thread 456."),
    );

    expect(sameScope.status).toBe("bound");

    const differentAccount = await requestPluginConversationBinding(
      createDiscordCodexBindRequest(
        "channel:3",
        "Bind this conversation to Codex thread 789.",
        "work",
      ),
    );

    expect(differentAccount.status).toBe("pending");
  });

  it("shares pending bind approvals across duplicate module instances", async () => {
    const { first, second } = await importDuplicateConversationBindingModules();
    const request = await requestPendingBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:77",
        "77",
        "Bind this conversation to Codex thread abc.",
      ),
      first.requestPluginConversationBinding,
    );

    await expect(
      approveBindingRequest(
        request.approvalId,
        "allow-once",
        second.resolvePluginConversationBindingApproval,
      ),
    ).resolves.toMatchObject({
      binding: expect.objectContaining({
        conversationId: "-10099:topic:77",
        pluginId: "codex",
        pluginRoot: "/plugins/codex-a",
      }),
      status: "approved",
    });

    second.__testing.reset();
  });

  it("shares persistent approvals across duplicate module instances", async () => {
    const { first, second } = await importDuplicateConversationBindingModules();
    const request = await requestPendingBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:77",
        "77",
        "Bind this conversation to Codex thread abc.",
      ),
      first.requestPluginConversationBinding,
    );

    await expect(
      approveBindingRequest(
        request.approvalId,
        "allow-always",
        second.resolvePluginConversationBindingApproval,
      ),
    ).resolves.toMatchObject({
      decision: "allow-always",
      status: "approved",
    });

    const rebound = await first.requestPluginConversationBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:78",
        "78",
        "Bind this conversation to Codex thread def.",
      ),
    );

    expect(rebound.status).toBe("bound");

    first.__testing.reset();
    fs.rmSync(approvalsPath, { force: true });
  });

  it("does not share persistent approvals across plugin roots even with the same plugin id", async () => {
    const request = await requestPluginConversationBinding(
      createCodexBindRequest({
        accountId: "default",
        channel: "telegram",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        summary: "Bind this conversation to Codex thread abc.",
        threadId: "77",
      }),
    );

    expect(request.status).toBe("pending");
    if (request.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    await resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "allow-always",
      senderId: "user-1",
    });

    const samePluginNewPath = await requestPluginConversationBinding(
      createCodexBindRequest({
        accountId: "default",
        channel: "telegram",
        conversationId: "-10099:topic:78",
        parentConversationId: "-10099",
        pluginRoot: "/plugins/codex-b",
        summary: "Bind this conversation to Codex thread def.",
        threadId: "78",
      }),
    );

    expect(samePluginNewPath.status).toBe("pending");
  });

  it("persists detachHint on approved plugin bindings", async () => {
    const binding = await requestResolvedBinding(
      createCodexBindRequest({
        accountId: "isolated",
        channel: "discord",
        conversationId: "channel:detach-hint",
        detachHint: "/codex_detach",
        summary: "Bind this conversation to Codex thread 999.",
      }),
    );

    expect(binding.detachHint).toBe("/codex_detach");

    const currentBinding = await getCurrentPluginConversationBinding({
      conversation: {
        accountId: "isolated",
        channel: "discord",
        conversationId: "channel:detach-hint",
      },
      pluginRoot: "/plugins/codex-a",
    });

    expect(currentBinding?.detachHint).toBe("/codex_detach");
  });

  it.each([
    {
      decision: "allow-once" as const,
      expectedCallback: {
        binding: expect.objectContaining({
          conversationId: "channel:callback-test",
          pluginId: "codex",
          pluginRoot: "/plugins/callback-test",
        }),
        decision: "allow-once",
        request: {
          conversation: {
            accountId: "isolated",
            channel: "discord",
            conversationId: "channel:callback-test",
          },
          detachHint: undefined,
          requestedBySenderId: "user-1",
          summary: "Bind this conversation to Codex thread abc.",
        },
        status: "approved",
      },
      expectedStatus: "approved" as const,
      name: "notifies the owning plugin when a bind approval is approved",
      pluginRoot: "/plugins/callback-test",
      requestInput: {
        binding: { summary: "Bind this conversation to Codex thread abc." },
        conversation: {
          accountId: "isolated",
          channel: "discord",
          conversationId: "channel:callback-test",
        },
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-test",
        requestedBySenderId: "user-1",
      },
    },
    {
      decision: "deny" as const,
      expectedCallback: {
        binding: undefined,
        decision: "deny",
        request: {
          conversation: {
            accountId: "default",
            channel: "telegram",
            conversationId: "8460800771",
          },
          detachHint: undefined,
          requestedBySenderId: "user-1",
          summary: "Bind this conversation to Codex thread deny.",
        },
        status: "denied",
      },
      expectedStatus: "denied" as const,
      name: "notifies the owning plugin when a bind approval is denied",
      pluginRoot: "/plugins/callback-deny",
      requestInput: {
        binding: { summary: "Bind this conversation to Codex thread deny." },
        conversation: {
          accountId: "default",
          channel: "telegram",
          conversationId: "8460800771",
        },
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-deny",
        requestedBySenderId: "user-1",
      },
    },
  ] as const)("$name", async (testCase) => {
    await expectResolutionCallback(testCase);
  });

  it.each([
    {
      decision: "allow-once" as const,
      expectedStatus: "approved" as const,
      name: "does not wait for an approved bind callback before returning",
      pluginRoot: "/plugins/callback-slow-approve",
      requestInput: {
        binding: { summary: "Bind this conversation to Codex thread slow-approve." },
        conversation: {
          accountId: "isolated",
          channel: "discord",
          conversationId: "channel:slow-approve",
        },
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-slow-approve",
        requestedBySenderId: "user-1",
      },
    },
    {
      decision: "deny" as const,
      expectedStatus: "denied" as const,
      name: "does not wait for a denied bind callback before returning",
      pluginRoot: "/plugins/callback-slow-deny",
      requestInput: {
        binding: { summary: "Bind this conversation to Codex thread slow-deny." },
        conversation: {
          accountId: "default",
          channel: "telegram",
          conversationId: "slow-deny",
        },
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-slow-deny",
        requestedBySenderId: "user-1",
      },
    },
  ] as const)("$name", async (testCase) => {
    await expectResolutionDoesNotWait(testCase);
  });

  it("returns and detaches only bindings owned by the requesting plugin root", async () => {
    await requestResolvedBinding({
      binding: { summary: "Bind this conversation to Codex thread 123." },
      conversation: {
        accountId: "isolated",
        channel: "discord",
        conversationId: "channel:1",
      },
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
    });

    const current = await getCurrentPluginConversationBinding({
      conversation: {
        accountId: "isolated",
        channel: "discord",
        conversationId: "channel:1",
      },
      pluginRoot: "/plugins/codex-a",
    });

    expect(current).toEqual(
      expect.objectContaining({
        conversationId: "channel:1",
        pluginId: "codex",
        pluginRoot: "/plugins/codex-a",
      }),
    );

    const otherPluginView = await getCurrentPluginConversationBinding({
      conversation: {
        accountId: "isolated",
        channel: "discord",
        conversationId: "channel:1",
      },
      pluginRoot: "/plugins/codex-b",
    });

    expect(otherPluginView).toBeNull();

    expect(
      await detachPluginConversationBinding({
        conversation: {
          accountId: "isolated",
          channel: "discord",
          conversationId: "channel:1",
        },
        pluginRoot: "/plugins/codex-b",
      }),
    ).toEqual({ removed: false });

    expect(
      await detachPluginConversationBinding({
        conversation: {
          accountId: "isolated",
          channel: "discord",
          conversationId: "channel:1",
        },
        pluginRoot: "/plugins/codex-a",
      }),
    ).toEqual({ removed: true });
  });

  it("refuses to claim a conversation already bound by core", async () => {
    sessionBindingState.setRecord({
      bindingId: "binding-core",
      boundAt: Date.now(),
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:1",
      },
      metadata: { owner: "core" },
      status: "active",
      targetKind: "session",
      targetSessionKey: "agent:main:discord:channel:1",
    });

    const result = await requestPluginConversationBinding({
      binding: { summary: "Bind this conversation to Codex thread 123." },
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:1",
      },
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
    });

    expect(result).toEqual({
      message:
        "This conversation is already bound by core routing and cannot be claimed by a plugin.",
      status: "error",
    });
  });

  it.each([
    {
      existingRecord: {
        bindingId: "binding-legacy",
        conversation: {
          accountId: "default",
          channel: "telegram",
          conversationId: "-10099:topic:77",
        },
        metadata: {
          label: "legacy plugin bind",
        },
        status: "active" as const,
        targetKind: "session" as const,
        targetSessionKey: "plugin-binding:old-codex-plugin:legacy123",
      },
      expectedBinding: {
        conversationId: "-10099:topic:77",
        pluginId: "codex",
        pluginRoot: "/plugins/codex-a",
      },
      name: "migrates a legacy plugin binding record through the new approval flow even if the old plugin id differs",
      requestInput: createCodexBindRequest({
        accountId: "default",
        channel: "telegram",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        summary: "Bind this conversation to Codex thread abc.",
        threadId: "77",
      }),
    },
    {
      existingRecord: {
        bindingId: "binding-legacy-codex-thread",
        conversation: {
          accountId: "default",
          channel: "telegram",
          conversationId: "8460800771",
        },
        metadata: {
          label: "legacy codex thread bind",
        },
        status: "active" as const,
        targetKind: "session" as const,
        targetSessionKey: "openclaw-app-server:thread:019ce411-6322-7db2-a821-1a61c530e7d9",
      },
      expectedBinding: {
        conversationId: "8460800771",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex-a",
      },
      name: "migrates a legacy codex thread binding session key through the new approval flow",
      requestInput: createCodexBindRequest({
        accountId: "default",
        channel: "telegram",
        conversationId: "8460800771",
        pluginId: "openclaw-codex-app-server",
        summary: "Bind this conversation to Codex thread 019ce411-6322-7db2-a821-1a61c530e7d9.",
      }),
    },
  ] as const)("$name", async ({ existingRecord, requestInput, expectedBinding }) => {
    sessionBindingState.setRecord({
      ...existingRecord,
      boundAt: Date.now(),
    });

    const request = await requestPluginConversationBinding(requestInput);
    const binding = await resolveRequestedBinding(request);

    expect(binding).toEqual(expect.objectContaining(expectedBinding));
  });
});
