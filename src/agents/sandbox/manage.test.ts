import { beforeEach, describe, expect, it, vi } from "vitest";

let listSandboxBrowsers: typeof import("./manage.js").listSandboxBrowsers;
let removeSandboxBrowserContainer: typeof import("./manage.js").removeSandboxBrowserContainer;

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  readRegistry: vi.fn(),
  removeBrowserRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
}));

const backendMocks = vi.hoisted(() => ({
  describeRuntime: vi.fn(),
  removeRuntime: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: configMocks.loadConfig,
  };
});

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  readRegistry: registryMocks.readRegistry,
  removeBrowserRegistryEntry: registryMocks.removeBrowserRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
}));

vi.mock("./docker-backend.js", () => ({
  createDockerSandboxBackend: vi.fn(),
  dockerSandboxBackendManager: {
    describeRuntime: backendMocks.describeRuntime,
    removeRuntime: backendMocks.removeRuntime,
  },
}));

async function loadFreshModule() {
  vi.resetModules();
  ({ listSandboxBrowsers, removeSandboxBrowserContainer } = await import("./manage.js"));
}

describe("listSandboxBrowsers", () => {
  beforeEach(async () => {
    configMocks.loadConfig.mockReset();
    registryMocks.readBrowserRegistry.mockReset();
    registryMocks.readRegistry.mockReset();
    registryMocks.removeBrowserRegistryEntry.mockReset();
    registryMocks.removeRegistryEntry.mockReset();
    backendMocks.describeRuntime.mockReset();
    backendMocks.removeRuntime.mockReset();

    configMocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              enabled: true,
              image: "openclaw-sandbox-browser:bookworm-slim",
            },
            docker: {
              image: "openclaw-sandbox:bookworm-slim",
            },
            mode: "all",
            scope: "session",
            workspaceAccess: "none",
          },
        },
        list: [],
      },
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          cdpPort: 9222,
          containerName: "browser-1",
          createdAtMs: 1,
          image: "stale-entry-image",
          lastUsedAtMs: 1,
          sessionKey: "agent:coder:main",
        },
      ],
    });
    backendMocks.describeRuntime.mockResolvedValue({
      actualConfigLabel: "openclaw-sandbox-browser:bookworm-slim",
      configLabelMatch: true,
      running: true,
    });

    await loadFreshModule();
  });

  it("compares browser runtimes against sandbox.browser.image", async () => {
    const results = await listSandboxBrowsers();

    expect(backendMocks.describeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "coder",
        entry: expect.objectContaining({
          configLabelKind: "BrowserImage",
        }),
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      image: "openclaw-sandbox-browser:bookworm-slim",
      imageMatch: true,
      running: true,
    });
  });

  it("removes browser runtimes with BrowserImage config label kind", async () => {
    await removeSandboxBrowserContainer("browser-1");

    expect(backendMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          backendId: "docker",
          configLabelKind: "BrowserImage",
          containerName: "browser-1",
          runtimeLabel: "browser-1",
        }),
      }),
    );
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledWith("browser-1");
  });
});
