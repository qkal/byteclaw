import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProfileResetOps } from "./server-context.reset.js";

const trashMocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (from: string) => `${from}.trashed`),
}));

const pwAiMocks = vi.hoisted(() => ({
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
}));

vi.mock("./trash.js", () => trashMocks);
vi.mock("./pw-ai.js", () => pwAiMocks);

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function localOpenClawProfile(): Parameters<typeof createProfileResetOps>[0]["profile"] {
  return {
    attachOnly: false,
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    cdpPort: 18_800,
    cdpUrl: "http://127.0.0.1:18800",
    color: "#f60",
    driver: "openclaw",
    name: "openclaw",
  };
}

function createLocalOpenClawResetOps(
  params: Omit<Parameters<typeof createProfileResetOps>[0], "profile">,
) {
  return createProfileResetOps({ profile: localOpenClawProfile(), ...params });
}

function createStatelessResetOps(profile: Parameters<typeof createProfileResetOps>[0]["profile"]) {
  return createProfileResetOps({
    getProfileState: () => ({ profile: {} as never, running: null }),
    isHttpReachable: vi.fn(async () => false),
    profile,
    resolveOpenClawUserDataDir: (name: string) => `/tmp/${name}`,
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
  });
}

describe("createProfileResetOps", () => {
  it("rejects remote non-extension profiles", async () => {
    const ops = createStatelessResetOps({
      ...localOpenClawProfile(),
      cdpHost: "browserless.example",
      cdpIsLoopback: false,
      cdpPort: 443,
      cdpUrl: "https://browserless.example/chrome",
      color: "#0f0",
      name: "remote",
    });

    await expect(ops.resetProfile()).rejects.toThrow(/only supported for local profiles/i);
  });

  it("stops local browser, closes playwright connection, and trashes profile dir", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-"));
    const profileDir = path.join(tempRoot, "openclaw");
    fs.mkdirSync(profileDir, { recursive: true });

    const stopRunningBrowser = vi.fn(async () => ({ stopped: true }));
    const isHttpReachable = vi.fn(async () => true);
    const getProfileState = vi.fn(() => ({
      profile: {} as never,
      running: { pid: 1 } as never,
    }));

    const ops = createLocalOpenClawResetOps({
      getProfileState,
      isHttpReachable,
      resolveOpenClawUserDataDir: () => profileDir,
      stopRunningBrowser,
    });

    const result = await ops.resetProfile();
    expect(result).toEqual({
      from: profileDir,
      moved: true,
      to: `${profileDir}.trashed`,
    });
    expect(isHttpReachable).toHaveBeenCalledWith(300);
    expect(stopRunningBrowser).toHaveBeenCalledTimes(1);
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
    });
    expect(trashMocks.movePathToTrash).toHaveBeenCalledWith(profileDir);
  });

  it("forces playwright disconnect when loopback cdp is occupied by non-owned process", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-no-own-"));
    const profileDir = path.join(tempRoot, "openclaw");
    fs.mkdirSync(profileDir, { recursive: true });

    const stopRunningBrowser = vi.fn(async () => ({ stopped: false }));
    const ops = createLocalOpenClawResetOps({
      getProfileState: () => ({ profile: {} as never, running: null }),
      isHttpReachable: vi.fn(async () => true),
      resolveOpenClawUserDataDir: () => profileDir,
      stopRunningBrowser,
    });

    await ops.resetProfile();
    expect(stopRunningBrowser).not.toHaveBeenCalled();
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(1, {
      cdpUrl: "http://127.0.0.1:18800",
    });
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(2, {
      cdpUrl: "http://127.0.0.1:18800",
    });
  });
});
