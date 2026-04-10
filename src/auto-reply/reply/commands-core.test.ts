import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      readFile: fsMocks.readFile,
      readdir: fsMocks.readdir,
    },
    readFile: fsMocks.readFile,
    readdir: fsMocks.readdir,
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

const { emitResetCommandHooks } = await import("./commands-reset-hooks.js");

describe("emitResetCommandHooks", () => {
  async function runBeforeResetContext(sessionKey?: string) {
    const command = {
      channel: "discord",
      from: "discord:rai",
      resetHookTriggered: false,
      senderId: "rai",
      surface: "discord",
      to: "discord:bot",
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "new",
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      ctx: {} as HandleCommandsParams["ctx"],
      previousSessionEntry: {
        sessionId: "prev-session",
      } as HandleCommandsParams["previousSessionEntry"],
      sessionKey,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1);
    const [, ctx] = hookRunnerMocks.runBeforeReset.mock.calls[0] ?? [];
    return ctx;
  }

  beforeEach(() => {
    fsMocks.readFile.mockReset();
    fsMocks.readdir.mockReset();
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    fsMocks.readFile.mockResolvedValue("");
    fsMocks.readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the bound agent id to before_reset hooks for multi-agent session keys", async () => {
    const ctx = await runBeforeResetContext("agent:navi:main");
    expect(ctx).toMatchObject({
      agentId: "navi",
      sessionId: "prev-session",
      sessionKey: "agent:navi:main",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("falls back to main when the reset hook has no session key", async () => {
    const ctx = await runBeforeResetContext(undefined);
    expect(ctx).toMatchObject({
      agentId: "main",
      sessionId: "prev-session",
      sessionKey: undefined,
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("keeps the main-agent path on the main agent workspace", async () => {
    const ctx = await runBeforeResetContext("agent:main:main");
    expect(ctx).toMatchObject({
      agentId: "main",
      sessionId: "prev-session",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("recovers the archived transcript when the original reset transcript path is gone", async () => {
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMocks.readdir.mockResolvedValueOnce(["prev-session.jsonl.reset.2026-02-16T22-26-33.000Z"]);
    fsMocks.readFile.mockResolvedValueOnce(
      `${JSON.stringify({
        id: "m1",
        message: { content: "Recovered from archive", role: "user" },
        type: "message",
      })}\n`,
    );
    const command = {
      channel: "telegram",
      from: "telegram:vac",
      resetHookTriggered: false,
      senderId: "vac",
      surface: "telegram",
      to: "telegram:bot",
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "new",
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      ctx: {} as HandleCommandsParams["ctx"],
      previousSessionEntry: {
        sessionFile: "/tmp/prev-session.jsonl",
        sessionId: "prev-session",
      } as HandleCommandsParams["previousSessionEntry"],
      sessionKey: "agent:main:telegram:group:-1003826723328:topic:8428",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ content: "Recovered from archive", role: "user" }],
        reason: "new",
        sessionFile: "/tmp/prev-session.jsonl.reset.2026-02-16T22-26-33.000Z",
      }),
      expect.objectContaining({
        sessionId: "prev-session",
      }),
    );
  });
});
