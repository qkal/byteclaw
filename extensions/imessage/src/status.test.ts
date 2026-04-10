import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as setupRuntime from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/plugins/setup-wizard.js";
import { resolveIMessageAccount } from "./accounts.js";
import * as channelRuntimeModule from "./channel.runtime.js";
import * as clientModule from "./client.js";
import { probeIMessage } from "./probe.js";
import { imessageSetupWizard } from "./setup-surface.js";
import { probeIMessageStatusAccount } from "./status-core.js";

const getIMessageSetupStatus = createPluginSetupWizardStatus({
  id: "imessage",
  meta: {
    label: "iMessage",
  },
  setupWizard: imessageSetupWizard,
} as never);

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

describe("createIMessageRpcClient", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    vi.stubEnv("VITEST", "true");
  });

  it("refuses to spawn imsg rpc in test environments", async () => {
    const { createIMessageRpcClient } = await import("./client.js");
    await expect(createIMessageRpcClient()).rejects.toThrow(
      /Refusing to start imsg rpc in test environment/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("imessage setup status", () => {
  it("does not inherit configured state from a sibling account", async () => {
    const result = await getIMessageSetupStatus({
      accountOverrides: {
        imessage: "work",
      },
      cfg: {
        channels: {
          imessage: {
            accounts: {
              default: {
                cliPath: "/usr/local/bin/imsg",
              },
              work: {},
            },
          },
        },
      },
    });

    expect(result.configured).toBe(false);
    expect(result.statusLines).toContain("iMessage: needs setup");
  });

  it("uses configured defaultAccount for omitted setup status cliPath", async () => {
    const status = await getIMessageSetupStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          imessage: {
            accounts: {
              work: {
                cliPath: "/tmp/work-imsg",
              },
            },
            cliPath: "/tmp/root-imsg",
            defaultAccount: "work",
          },
        },
      } as never,
    });

    expect(status.statusLines).toContain("imsg: missing (/tmp/work-imsg)");
  });

  it("does not inherit configured state from a sibling when defaultAccount is named", async () => {
    const status = await getIMessageSetupStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          imessage: {
            accounts: {
              default: {
                cliPath: "/usr/local/bin/imsg",
              },
              work: {},
            },
            defaultAccount: "work",
          },
        },
      } as never,
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toContain("iMessage: needs setup");
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getIMessageSetupStatus({
      accountOverrides: { imessage: "work" },
      cfg: {
        channels: {
          imessage: {
            accounts: {
              work: {
                cliPath: "/tmp/work-imsg",
              },
            },
            cliPath: "/tmp/root-imsg",
          },
        },
      } as never,
    });

    expect(status.statusLines).toContain("imsg: missing (/tmp/work-imsg)");
  });
});

describe("probeIMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockClear();
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(true);
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      code: 1,
      killed: false,
      signal: null,
      stderr: 'unknown command "rpc" for "imsg"',
      stdout: "",
      termination: "exit",
    });
  });

  it("marks unknown rpc subcommand as fatal", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);
    const result = await probeIMessage(1000, { cliPath: "imsg-test-rpc" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("status probe uses account-scoped cliPath and dbPath", async () => {
    const probeSpy = vi.spyOn(channelRuntimeModule, "probeIMessageAccount").mockResolvedValue({
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
      ok: true,
    } as Awaited<ReturnType<typeof channelRuntimeModule.probeIMessageAccount>>);

    const cfg = {
      channels: {
        imessage: {
          accounts: {
            work: {
              cliPath: "imsg-work",
              dbPath: "/tmp/work-db",
            },
          },
          cliPath: "imsg-root",
          dbPath: "/tmp/root-db",
        },
      },
    } as const;
    const account = resolveIMessageAccount({ accountId: "work", cfg });

    await probeIMessageStatusAccount({
      account,
      probeIMessageAccount: channelRuntimeModule.probeIMessageAccount,
      timeoutMs: 2500,
    });

    expect(probeSpy).toHaveBeenCalledWith({
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
      timeoutMs: 2500,
    });
  });
});
