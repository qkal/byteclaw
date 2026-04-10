import type { Command } from "commander";
import { vi } from "vitest";
import * as parentCoreApiModule from "../core-api.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import * as cliCoreApiModule from "./core-api.js";

interface BrowserRequest { path?: string }
interface BrowserRuntimeOptions { timeoutMs?: number }

export type BrowserManageCall = [unknown, BrowserRequest, BrowserRuntimeOptions | undefined];

const browserManageMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      opts: unknown,
      req: BrowserRequest,
      runtimeOpts?: BrowserRuntimeOptions,
    ) => Promise<Record<string, unknown>>
  >(async (_opts: unknown, req: BrowserRequest) =>
    req.path === "/"
      ? {
          attachOnly: false,
          cdpPort: 18_800,
          chosenBrowser: "chrome",
          color: "blue",
          enabled: true,
          headless: true,
          pid: 1,
          running: true,
          userDataDir: "/tmp/openclaw",
        }
      : {},
  ),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(
  browserManageMocks.callBrowserRequest,
);
vi.spyOn(parentCoreApiModule, "runCommandWithRuntime").mockImplementation(
  async (_runtime, action, onError) => {
    try {
      await action();
    } catch (error) {
      onError?.(error);
    }
  },
);
const { createBrowserProgram, getBrowserCliRuntime } =
  await import("./browser-cli.test-support.js");
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserManageCommands } = await import("./browser-cli-manage.js");

export function createBrowserManageProgram(params?: { withParentTimeout?: boolean }): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  if (params?.withParentTimeout) {
    browser.option("--timeout <ms>", "Timeout in ms", "30000");
  }
  registerBrowserManageCommands(browser, parentOpts);
  return program;
}

export function getBrowserManageCallBrowserRequestMock() {
  return browserManageMocks.callBrowserRequest;
}

export function findBrowserManageCall(path: string): BrowserManageCall | undefined {
  return browserManageMocks.callBrowserRequest.mock.calls.find(
    (call) => (call[1] ?? {}).path === path,
  ) as BrowserManageCall | undefined;
}
