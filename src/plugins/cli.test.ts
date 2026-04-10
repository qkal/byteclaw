import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  loadConfig: vi.fn(),
  loadOpenClawPluginCliRegistry: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  memoryListAction: vi.fn(),
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPluginCliRegistry: (...args: unknown[]) =>
    mocks.loadOpenClawPluginCliRegistry(...args),
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
}));

let getPluginCliCommandDescriptors: typeof import("./cli.js").getPluginCliCommandDescriptors;
let loadValidatedConfigForPluginRegistration: typeof import("./cli.js").loadValidatedConfigForPluginRegistration;
let registerPluginCliCommands: typeof import("./cli.js").registerPluginCliCommands;
let registerPluginCliCommandsFromValidatedConfig: typeof import("./cli.js").registerPluginCliCommandsFromValidatedConfig;

function createProgram(existingCommandName?: string) {
  const program = new Command();
  if (existingCommandName) {
    program.command(existingCommandName);
  }
  return program;
}

function createCliRegistry(params?: {
  memoryCommands?: string[];
  memoryDescriptors?: {
    name: string;
    description: string;
    hasSubcommands: boolean;
  }[];
}) {
  return {
    cliRegistrars: [
      {
        commands: params?.memoryCommands ?? ["memory"],
        descriptors: params?.memoryDescriptors ?? [
          {
            description: "Memory commands",
            hasSubcommands: true,
            name: "memory",
          },
        ],
        pluginId: "memory-core",
        register: mocks.memoryRegister,
        source: "bundled",
      },
      {
        commands: ["other"],
        descriptors: [],
        pluginId: "other",
        register: mocks.otherRegister,
        source: "bundled",
      },
    ],
  };
}

function createEmptyCliRegistry(params?: { diagnostics?: { message: string }[] }) {
  return {
    cliRegistrars: [],
    diagnostics: params?.diagnostics ?? [],
  };
}

function createAutoEnabledCliFixture() {
  const rawConfig = {
    channels: { demo: { enabled: true } },
    plugins: {},
  } as OpenClawConfig;
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: {
      entries: {
        demo: { enabled: true },
      },
    },
  } as OpenClawConfig;
  return { autoEnabledConfig, rawConfig };
}

function expectAutoEnabledCliLoad(params: {
  rawConfig: OpenClawConfig;
  autoEnabledConfig: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
}) {
  expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
  expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
    expect.objectContaining({
      activationSourceConfig: params.rawConfig,
      autoEnabledReasons: params.autoEnabledReasons ?? {},
      config: params.autoEnabledConfig,
    }),
  );
}

describe("registerPluginCliCommands", () => {
  beforeAll(async () => {
    ({
      getPluginCliCommandDescriptors,
      loadValidatedConfigForPluginRegistration,
      registerPluginCliCommands,
      registerPluginCliCommandsFromValidatedConfig,
    } = await import("./cli.js"));
  });

  beforeEach(() => {
    mocks.memoryRegister.mockReset();
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
    });
    mocks.otherRegister.mockReset();
    mocks.otherRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("other").description("Other commands");
    });
    mocks.memoryListAction.mockReset();
    mocks.loadOpenClawPluginCliRegistry.mockReset();
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue(createCliRegistry());
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue({
      ...createCliRegistry(),
      diagnostics: [],
    });
    mocks.applyPluginAutoEnable.mockReset();
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      autoEnabledReasons: {},
      changes: [],
      config,
    }));
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      config: {},
      valid: true,
    });
  });

  it("skips plugin CLI registrars when commands already exist", async () => {
    const program = createProgram("memory");

    await registerPluginCliCommands(program, {} as OpenClawConfig);

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit env to plugin loading", async () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig, env);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("loads plugin CLI commands from the auto-enabled config snapshot", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });

    await registerPluginCliCommands(createProgram(), rawConfig);

    expectAutoEnabledCliLoad({
      autoEnabledConfig,
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      rawConfig,
    });
    expect(mocks.memoryRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
      }),
    );
  });

  it("loads root-help descriptors through the dedicated non-activating CLI collector", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          commands: ["matrix"],
          descriptors: [
            {
              description: "Matrix channel utilities",
              hasSubcommands: true,
              name: "matrix",
            },
          ],
          pluginId: "matrix",
          register: vi.fn(),
          source: "bundled",
        },
        {
          commands: ["matrix"],
          descriptors: [
            {
              description: "Duplicate Matrix channel utilities",
              hasSubcommands: true,
              name: "matrix",
            },
          ],
          pluginId: "duplicate-matrix",
          register: vi.fn(),
          source: "bundled",
        },
      ],
    });

    await expect(getPluginCliCommandDescriptors(rawConfig)).resolves.toEqual([
      {
        description: "Matrix channel utilities",
        hasSubcommands: true,
        name: "matrix",
      },
    ]);
    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
        config: autoEnabledConfig,
      }),
    );
  });

  it("keeps runtime CLI command registration on the full plugin loader for legacy channel plugins", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });
    mocks.loadOpenClawPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["legacy-channel"],
        memoryDescriptors: [
          {
            description: "Legacy channel commands",
            hasSubcommands: true,
            name: "legacy-channel",
          },
        ],
      }),
    );

    await registerPluginCliCommands(createProgram(), rawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
        config: autoEnabledConfig,
      }),
    );
    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
  });

  it("falls back to awaited CLI metadata collection when runtime loading ignored async registration", async () => {
    const asyncRegistrar = vi.fn(async ({ program }: { program: Command }) => {
      const asyncCommand = program.command("async-cli").description("Async CLI");
      asyncCommand.command("run").action(mocks.memoryListAction);
    });
    mocks.loadOpenClawPlugins.mockReturnValue(
      createEmptyCliRegistry({
        diagnostics: [
          {
            message: "plugin register returned a promise; async registration is ignored",
          },
        ],
      }),
    );
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          commands: ["async-cli"],
          descriptors: [
            {
              description: "Async CLI",
              hasSubcommands: true,
              name: "async-cli",
            },
          ],
          pluginId: "async-plugin",
          register: asyncRegistrar,
          source: "bundled",
        },
      ],
      diagnostics: [],
    });
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledTimes(1);
    await program.parseAsync(["async-cli", "run"], { from: "user" });
    expect(asyncRegistrar).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("lazy-registers descriptor-backed plugin commands on first invocation", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(program.commands.map((command) => command.name())).toEqual(["memory", "other"]);
    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("falls back to eager registration when descriptors do not cover every command root", async () => {
    mocks.loadOpenClawPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["memory", "memory-admin"],
        memoryDescriptors: [
          {
            description: "Memory commands",
            hasSubcommands: true,
            name: "memory",
          },
        ],
      }),
    );
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("memory");
      program.command("memory-admin");
    });

    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("registers a selected plugin primary eagerly during lazy startup", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(program.commands.filter((command) => command.name() === "memory")).toHaveLength(1);

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("returns null for validated plugin CLI config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      config: { plugins: { load: { paths: ["/tmp/evil"] } } },
      valid: false,
    });

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBeNull();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("loads validated plugin CLI config when the snapshot is valid", async () => {
    const loadedConfig = { plugins: { enabled: true } } as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      config: loadedConfig,
      valid: true,
    });
    mocks.loadConfig.mockReturnValueOnce(loadedConfig);

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBe(loadedConfig);
    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
  });

  it("skips plugin CLI registration from validated config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      config: {},
      valid: false,
    });

    await expect(registerPluginCliCommandsFromValidatedConfig(createProgram())).resolves.toBeNull();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
