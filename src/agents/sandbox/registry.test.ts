import fs from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TEST_STATE_DIR, SANDBOX_REGISTRY_PATH, SANDBOX_BROWSER_REGISTRY_PATH } = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));

  return {
    SANDBOX_BROWSER_REGISTRY_PATH: path.join(baseDir, "browsers.json"),
    SANDBOX_REGISTRY_PATH: path.join(baseDir, "containers.json"),
    TEST_STATE_DIR: baseDir,
  };
});

vi.mock("./constants.js", () => ({
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_STATE_DIR: TEST_STATE_DIR,
}));

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;

interface WriteDelayConfig {
  targetFile: "containers.json" | "browsers.json";
  containerName: string;
  started: boolean;
  markStarted: () => void;
  waitForRelease: Promise<void>;
}

let activeWriteGate: WriteDelayConfig | null = null;
let readBrowserRegistry: typeof import("./registry.js").readBrowserRegistry;
let readRegistry: typeof import("./registry.js").readRegistry;
let removeBrowserRegistryEntry: typeof import("./registry.js").removeBrowserRegistryEntry;
let removeRegistryEntry: typeof import("./registry.js").removeRegistryEntry;
let updateBrowserRegistry: typeof import("./registry.js").updateBrowserRegistry;
let updateRegistry: typeof import("./registry.js").updateRegistry;

async function loadFreshRegistryModuleForTest() {
  vi.resetModules();
  vi.doMock("./constants.js", () => ({
    SANDBOX_BROWSER_REGISTRY_PATH,
    SANDBOX_REGISTRY_PATH,
    SANDBOX_STATE_DIR: TEST_STATE_DIR,
  }));
  vi.doMock("../../infra/json-files.js", async () => {
    const actual = await vi.importActual<typeof import("../../infra/json-files.js")>(
      "../../infra/json-files.js",
    );
    return {
      ...actual,
      writeJsonAtomic: async (
        filePath: string,
        value: unknown,
        options?: Parameters<typeof actual.writeJsonAtomic>[2],
      ) => {
        const payload = JSON.stringify(value);
        const gate = activeWriteGate;
        if (
          gate &&
          filePath.includes(gate.targetFile) &&
          payloadMentionsContainer(payload, gate.containerName)
        ) {
          if (!gate.started) {
            gate.started = true;
            gate.markStarted();
          }
          await gate.waitForRelease;
        }
        await actual.writeJsonAtomic(filePath, value, options);
      },
    };
  });
  ({
    readBrowserRegistry,
    readRegistry,
    removeBrowserRegistryEntry,
    removeRegistryEntry,
    updateBrowserRegistry,
    updateRegistry,
  } = await import("./registry.js"));
}

function payloadMentionsContainer(payload: string, containerName: string): boolean {
  return (
    payload.includes(`"containerName":"${containerName}"`) ||
    payload.includes(`"containerName": "${containerName}"`)
  );
}

async function seedMalformedContainerRegistry(payload: string) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, payload, "utf8");
}

async function seedMalformedBrowserRegistry(payload: string) {
  await fs.writeFile(SANDBOX_BROWSER_REGISTRY_PATH, payload, "utf8");
}

function installWriteGate(
  targetFile: "containers.json" | "browsers.json",
  containerName: string,
): { waitForStart: Promise<void>; release: () => void } {
  let markStarted = () => {};
  const waitForStart = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let resolveRelease = () => {};
  const waitForRelease = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  activeWriteGate = {
    containerName,
    markStarted,
    started: false,
    targetFile,
    waitForRelease,
  };
  return {
    release: () => {
      resolveRelease();
      activeWriteGate = null;
    },
    waitForStart,
  };
}

beforeEach(async () => {
  activeWriteGate = null;
  await loadFreshRegistryModuleForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
  await fs.rm(SANDBOX_BROWSER_REGISTRY_PATH, { force: true });
  await fs.rm(`${SANDBOX_REGISTRY_PATH}.lock`, { force: true });
  await fs.rm(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`, { force: true });
});

afterAll(async () => {
  await fs.rm(TEST_STATE_DIR, { force: true, recursive: true });
});

function browserEntry(
  overrides: Partial<SandboxBrowserRegistryEntry> = {},
): SandboxBrowserRegistryEntry {
  return {
    cdpPort: 9222,
    containerName: "browser-a",
    createdAtMs: 1,
    image: "openclaw-browser:test",
    lastUsedAtMs: 1,
    sessionKey: "agent:main",
    ...overrides,
  };
}

function containerEntry(overrides: Partial<SandboxRegistryEntry> = {}): SandboxRegistryEntry {
  return {
    containerName: "container-a",
    createdAtMs: 1,
    image: "openclaw-sandbox:test",
    lastUsedAtMs: 1,
    sessionKey: "agent:main",
    ...overrides,
  };
}

async function seedContainerRegistry(entries: SandboxRegistryEntry[]) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

async function seedBrowserRegistry(entries: SandboxBrowserRegistryEntry[]) {
  await fs.writeFile(
    SANDBOX_BROWSER_REGISTRY_PATH,
    `${JSON.stringify({ entries }, null, 2)}\n`,
    "utf8",
  );
}

describe("registry race safety", () => {
  it("normalizes legacy registry entries on read", async () => {
    await seedContainerRegistry([
      {
        containerName: "legacy-container",
        createdAtMs: 1,
        image: "openclaw-sandbox:test",
        lastUsedAtMs: 1,
        sessionKey: "agent:main",
      },
    ]);

    const registry = await readRegistry();
    expect(registry.entries).toEqual([
      expect.objectContaining({
        backendId: "docker",
        configLabelKind: "Image",
        containerName: "legacy-container",
        runtimeLabel: "legacy-container",
      }),
    ]);
  });

  it("keeps both container updates under concurrent writes", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(registry.entries.map((entry) => entry.containerName).toSorted()).toEqual([
      "container-a",
      "container-b",
    ]);
  });

  it("prevents concurrent container remove/update from resurrecting deleted entries", async () => {
    await seedContainerRegistry([containerEntry({ containerName: "container-x" })]);
    const writeGate = installWriteGate("containers.json", "container-x");

    const updatePromise = updateRegistry(
      containerEntry({ configHash: "updated", containerName: "container-x" }),
    );
    await writeGate.waitForStart;
    const removePromise = removeRegistryEntry("container-x");
    writeGate.release();
    await Promise.all([updatePromise, removePromise]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("keeps both browser updates under concurrent writes", async () => {
    await Promise.all([
      updateBrowserRegistry(browserEntry({ containerName: "browser-a" })),
      updateBrowserRegistry(browserEntry({ cdpPort: 9223, containerName: "browser-b" })),
    ]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(registry.entries.map((entry) => entry.containerName).toSorted()).toEqual([
      "browser-a",
      "browser-b",
    ]);
  });

  it("prevents concurrent browser remove/update from resurrecting deleted entries", async () => {
    await seedBrowserRegistry([browserEntry({ containerName: "browser-x" })]);
    const writeGate = installWriteGate("browsers.json", "browser-x");

    const updatePromise = updateBrowserRegistry(
      browserEntry({ configHash: "updated", containerName: "browser-x" }),
    );
    await writeGate.waitForStart;
    const removePromise = removeBrowserRegistryEntry("browser-x");
    writeGate.release();
    await Promise.all([updatePromise, removePromise]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("fails fast when registry files are malformed during update", async () => {
    await seedMalformedContainerRegistry("{bad json");
    await seedMalformedBrowserRegistry("{bad json");
    await expect(updateRegistry(containerEntry())).rejects.toThrow();
    await expect(updateBrowserRegistry(browserEntry())).rejects.toThrow();
  });

  it("fails fast when registry entries are invalid during update", async () => {
    const invalidEntries = `{"entries":[{"sessionKey":"agent:main"}]}`;
    await seedMalformedContainerRegistry(invalidEntries);
    await seedMalformedBrowserRegistry(invalidEntries);
    await expect(updateRegistry(containerEntry())).rejects.toThrow(
      /Invalid sandbox registry format/,
    );
    await expect(updateBrowserRegistry(browserEntry())).rejects.toThrow(
      /Invalid sandbox registry format/,
    );
  });
});
