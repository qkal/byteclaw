import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createPtyAdapterMock } = vi.hoisted(() => ({
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("../../agents/shell-utils.js", () => ({
  getShellConfig: () => ({ args: ["-c"], shell: "sh" }),
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: (...args: unknown[]) => createPtyAdapterMock(...args),
}));

function createStubPtyAdapter() {
  return {
    dispose: () => {
      // No-op
    },
    kill: (_signal?: NodeJS.Signals) => {
      // No-op
    },
    onStderr: (_listener: (chunk: string) => void) => {
      // No-op
    },
    onStdout: (_listener: (chunk: string) => void) => {
      // No-op
    },
    pid: 1234,
    stdin: undefined,
    wait: async () => ({ code: 0, signal: null }),
  };
}

describe("process supervisor PTY command contract", () => {
  let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

  beforeAll(async () => {
    ({ createProcessSupervisor } = await import("./supervisor.js"));
  });

  beforeEach(() => {
    createPtyAdapterMock.mockClear();
  });

  it("passes PTY command verbatim to shell args", async () => {
    createPtyAdapterMock.mockResolvedValue(createStubPtyAdapter());
    const supervisor = createProcessSupervisor();
    const command = `printf '%s\\n' "a b" && printf '%s\\n' '$HOME'`;

    const run = await supervisor.spawn({
      backendId: "test",
      mode: "pty",
      ptyCommand: command,
      sessionId: "s1",
      timeoutMs: 1000,
    });
    const exit = await run.wait();

    expect(exit.reason).toBe("exit");
    expect(createPtyAdapterMock).toHaveBeenCalledTimes(1);
    const params = createPtyAdapterMock.mock.calls[0]?.[0] as { args?: string[] };
    expect(params.args).toEqual(["-c", command]);
  });

  it("rejects empty PTY command", async () => {
    createPtyAdapterMock.mockResolvedValue(createStubPtyAdapter());
    const supervisor = createProcessSupervisor();

    await expect(
      supervisor.spawn({
        backendId: "test",
        mode: "pty",
        ptyCommand: "   ",
        sessionId: "s1",
      }),
    ).rejects.toThrow("PTY command cannot be empty");
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
  });
});
