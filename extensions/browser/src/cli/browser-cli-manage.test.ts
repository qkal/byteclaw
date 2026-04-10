import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserManageProgram,
  getBrowserManageCallBrowserRequestMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntime, getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

describe("browser manage output", () => {
  beforeEach(() => {
    getBrowserManageCallBrowserRequestMock().mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("shows chrome-mcp transport for existing-session status without fake CDP fields", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            attachOnly: true,
            cdpHttp: true,
            cdpPort: null,
            cdpReady: true,
            cdpUrl: null,
            chosenBrowser: null,
            color: "#00AA00",
            driver: "existing-session",
            enabled: true,
            executablePath: null,
            headless: false,
            noSandbox: false,
            pid: 4321,
            profile: "chrome-live",
            running: true,
            transport: "chrome-mcp",
            userDataDir: null,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome-live", "status"], {
      from: "user",
    });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("cdpPort:");
    expect(output).not.toContain("cdpUrl:");
  });

  it("shows configured userDataDir for existing-session status", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            attachOnly: true,
            cdpHttp: true,
            cdpPort: null,
            cdpReady: true,
            cdpUrl: null,
            chosenBrowser: null,
            color: "#FB542B",
            driver: "existing-session",
            enabled: true,
            executablePath: null,
            headless: false,
            noSandbox: false,
            pid: 4321,
            profile: "brave-live",
            running: true,
            transport: "chrome-mcp",
            userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "brave-live", "status"], {
      from: "user",
    });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain(
      "userDataDir: /Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
    );
  });

  it("shows chrome-mcp transport in browser profiles output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles"
        ? {
            profiles: [
              {
                cdpPort: null,
                cdpUrl: null,
                color: "#00AA00",
                driver: "existing-session",
                isDefault: false,
                isRemote: false,
                name: "chrome-live",
                running: true,
                tabCount: 2,
                transport: "chrome-mcp",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("chrome-live: running (2 tabs) [existing-session]");
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("shows chrome-mcp transport after creating an existing-session profile", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles/create"
        ? {
            cdpPort: null,
            cdpUrl: null,
            color: "#00AA00",
            isRemote: false,
            ok: true,
            profile: "chrome-live",
            transport: "chrome-mcp",
            userDataDir: null,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      ["browser", "create-profile", "--name", "chrome-live", "--driver", "existing-session"],
      { from: "user" },
    );

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("redacts sensitive remote cdpUrl details in status output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            attachOnly: true,
            cdpHttp: true,
            cdpPort: 9222,
            cdpReady: true,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            chosenBrowser: null,
            color: "#00AA00",
            driver: "openclaw",
            enabled: true,
            executablePath: null,
            headless: false,
            noSandbox: false,
            pid: null,
            profile: "remote",
            running: true,
            transport: "cdp",
            userDataDir: null,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "remote", "status"], {
      from: "user",
    });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });
});
