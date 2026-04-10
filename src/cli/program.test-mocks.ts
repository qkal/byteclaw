import { type Mock, vi } from "vitest";

type AnyMock = Mock<(...args: unknown[]) => unknown>;

const programMocks = vi.hoisted(() => {
  const setupWizardCommand = vi.fn();
  return {
    callGateway: vi.fn(),
    configureCommand: vi.fn(),
    configureCommandWithSections: vi.fn(),
    ensureConfigReady: vi.fn(),
    ensurePluginRegistryLoaded: vi.fn(),
    loadAndMaybeMigrateDoctorConfig: vi.fn(),
    messageCommand: vi.fn(),
    onboardCommand: setupWizardCommand,
    runChannelLogin: vi.fn(),
    runChannelLogout: vi.fn(),
    runTui: vi.fn(),
    runtime: {
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
      log: vi.fn(),
    },
    setupCommand: vi.fn(),
    setupWizardCommand,
    statusCommand: vi.fn(),
  };
});

export const messageCommand = programMocks.messageCommand as AnyMock;
export const statusCommand = programMocks.statusCommand as AnyMock;
export const configureCommand = programMocks.configureCommand as AnyMock;
export const configureCommandWithSections = programMocks.configureCommandWithSections as AnyMock;
export const setupCommand = programMocks.setupCommand as AnyMock;
export const onboardCommand = programMocks.onboardCommand as AnyMock;
export const setupWizardCommand = programMocks.setupWizardCommand as AnyMock;
export const callGateway = programMocks.callGateway as AnyMock;
export const runChannelLogin = programMocks.runChannelLogin as AnyMock;
export const runChannelLogout = programMocks.runChannelLogout as AnyMock;
export const runTui = programMocks.runTui as AnyMock;
export const loadAndMaybeMigrateDoctorConfig =
  programMocks.loadAndMaybeMigrateDoctorConfig as AnyMock;
export const ensureConfigReady = programMocks.ensureConfigReady as AnyMock;
export const ensurePluginRegistryLoaded = programMocks.ensurePluginRegistryLoaded as AnyMock;

export const runtime = programMocks.runtime as {
  log: Mock<(...args: unknown[]) => void>;
  error: Mock<(...args: unknown[]) => void>;
  exit: Mock<(...args: unknown[]) => never>;
};

// Keep these mocks at top level so Vitest does not warn about hoisted nested mocks.
vi.mock("../commands/message.js", () => ({ messageCommand: programMocks.messageCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand: programMocks.statusCommand }));
vi.mock("../commands/configure.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: [
    "workspace",
    "model",
    "web",
    "gateway",
    "daemon",
    "channels",
    "skills",
    "health",
  ],
  configureCommand: programMocks.configureCommand,
  configureCommandFromSectionsArg: (sections: unknown, runtime: unknown) => {
    const resolved = Array.isArray(sections) ? sections : [];
    if (resolved.length > 0) {
      return programMocks.configureCommandWithSections(resolved, runtime);
    }
    return programMocks.configureCommand({}, runtime);
  },
  configureCommandWithSections: programMocks.configureCommandWithSections,
}));
vi.mock("../commands/setup.js", () => ({ setupCommand: programMocks.setupCommand }));
vi.mock("../commands/onboard.js", () => ({
  onboardCommand: programMocks.onboardCommand,
  setupWizardCommand: programMocks.setupWizardCommand,
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: programMocks.runtime }));
vi.mock("./channel-auth.js", () => ({
  runChannelLogin: programMocks.runChannelLogin,
  runChannelLogout: programMocks.runChannelLogout,
}));
vi.mock("../tui/tui.js", () => ({ runTui: programMocks.runTui }));
vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: () => ({
    message: "Gateway target: ws://127.0.0.1:1234",
    url: "ws://127.0.0.1:1234",
    urlSource: "test",
  }),
  callGateway: programMocks.callGateway,
  randomIdempotencyKey: () => "idem-test",
}));
vi.mock("./deps.js", () => ({ createDefaultDeps: () => ({}) }));
vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: programMocks.ensurePluginRegistryLoaded,
}));
vi.mock("../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: programMocks.loadAndMaybeMigrateDoctorConfig,
}));
vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: programMocks.ensureConfigReady,
}));
vi.mock("./preaction.js", () => ({ registerPreActionHooks: () => {} }));

export function installBaseProgramMocks() {}

export function installSmokeProgramMocks() {}
