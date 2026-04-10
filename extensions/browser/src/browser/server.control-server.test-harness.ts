import { afterEach, beforeEach, vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";
import { getFreePort } from "./test-port.js";

export { getFreePort } from "./test-port.js";

interface HarnessState {
  testPort: number;
  cdpBaseUrl: string;
  reachable: boolean;
  cfgAttachOnly: boolean;
  cfgEvaluateEnabled: boolean;
  cfgDefaultProfile: string;
  cfgProfiles: Record<
    string,
    {
      cdpPort?: number;
      cdpUrl?: string;
      color: string;
      driver?: "openclaw" | "existing-session";
      attachOnly?: boolean;
    }
  >;
  createTargetId: string | null;
  prevGatewayPort: string | undefined;
  prevGatewayToken: string | undefined;
  prevGatewayPassword: string | undefined;
}

const state: HarnessState = {
  cdpBaseUrl: "",
  cfgAttachOnly: false,
  cfgDefaultProfile: "openclaw",
  cfgEvaluateEnabled: true,
  cfgProfiles: {},
  createTargetId: null,
  prevGatewayPassword: undefined,
  prevGatewayPort: undefined,
  prevGatewayToken: undefined,
  reachable: false,
  testPort: 0,
};

export function getBrowserControlServerTestState(): HarnessState {
  return state;
}

export function getBrowserControlServerBaseUrl(): string {
  return `http://127.0.0.1:${state.testPort}`;
}

export function restoreGatewayPortEnv(prevGatewayPort: string | undefined): void {
  if (prevGatewayPort === undefined) {
    delete process.env.OPENCLAW_GATEWAY_PORT;
    return;
  }
  process.env.OPENCLAW_GATEWAY_PORT = prevGatewayPort;
}

export function setBrowserControlServerCreateTargetId(targetId: string | null): void {
  state.createTargetId = targetId;
}

export function setBrowserControlServerAttachOnly(attachOnly: boolean): void {
  state.cfgAttachOnly = attachOnly;
}

export function setBrowserControlServerEvaluateEnabled(enabled: boolean): void {
  state.cfgEvaluateEnabled = enabled;
}

export function setBrowserControlServerReachable(reachable: boolean): void {
  state.reachable = reachable;
}

export function setBrowserControlServerProfiles(
  profiles: HarnessState["cfgProfiles"],
  defaultProfile = Object.keys(profiles)[0] ?? "openclaw",
): void {
  state.cfgProfiles = profiles;
  state.cfgDefaultProfile = defaultProfile;
}

const cdpMocks = vi.hoisted(() => ({
  createTargetViaCdp: vi.fn<() => Promise<{ targetId: string }>>(async () => {
    throw new Error("cdp disabled");
  }),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ depth: 0, name: "x", ref: "1", role: "link" }],
  })),
}));

export function getCdpMocks(): { createTargetViaCdp: MockFn; snapshotAria: MockFn } {
  return cdpMocks as unknown as { createTargetViaCdp: MockFn; snapshotAria: MockFn };
}

type ExecuteActMockAction = { kind: string } & Record<string, unknown>;
interface ExecuteActMockOptions {
  cdpUrl: string;
  action: ExecuteActMockAction;
  targetId?: string;
  ssrfPolicy?: unknown;
  evaluateEnabled?: boolean;
  signal?: AbortSignal;
}

interface PassThroughActDispatch {
  mock: (opts?: unknown) => Promise<unknown>;
  fields: readonly string[];
  includeSsrf?: boolean;
  includeSignal?: boolean;
}

function pickActionFields(
  action: ExecuteActMockAction,
  fields: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    picked[field] = action[field];
  }
  return picked;
}

function buildActPayload(params: {
  cdpUrl: string;
  targetId?: string;
  action: ExecuteActMockAction;
  fields: readonly string[];
  ssrfPolicy?: unknown;
  signal?: AbortSignal;
  includeSsrf?: boolean;
  includeSignal?: boolean;
}): Record<string, unknown> {
  return {
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    ...pickActionFields(params.action, params.fields),
    ...(params.includeSsrf ? { ssrfPolicy: params.ssrfPolicy } : {}),
    ...(params.includeSignal ? { signal: params.signal } : {}),
  };
}

const pwMocks = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn(async () => {}),
  armFileUploadViaPlaywright: vi.fn(async () => {}),
  batchViaPlaywright: vi.fn(async (_opts?: unknown) => ({ results: [] })),
  clickViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  closePageViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
  downloadViaPlaywright: vi.fn(async () => ({
    path: "/tmp/report.pdf",
    suggestedFilename: "report.pdf",
    url: "https://example.com/report.pdf",
  })),
  dragViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  evaluateViaPlaywright: vi.fn(async (_opts?: unknown) => "ok"),
  executeActViaPlaywright: vi.fn(async (_opts?: ExecuteActMockOptions) => ({})),
  fillFormViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  getConsoleMessagesViaPlaywright: vi.fn(async () => []),
  hoverViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  navigateViaPlaywright: vi.fn(async () => ({ url: "https://example.com" })),
  pdfViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("pdf") })),
  pressKeyViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  resizeViewportViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  responseBodyViaPlaywright: vi.fn(async () => ({
    body: '{"ok":true}',
    headers: { "content-type": "application/json" },
    status: 200,
    url: "https://example.com/api/data",
  })),
  scrollIntoViewViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  selectOptionViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "ok" })),
  takeScreenshotViaPlaywright: vi.fn(async () => ({
    buffer: Buffer.from("png"),
  })),
  traceStopViaPlaywright: vi.fn(async () => {}),
  typeViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  waitForDownloadViaPlaywright: vi.fn(async () => ({
    path: "/tmp/report.pdf",
    suggestedFilename: "report.pdf",
    url: "https://example.com/report.pdf",
  })),
  waitForViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
}));

const passThroughActDispatch: Record<string, PassThroughActDispatch> = {
  click: {
    fields: ["ref", "selector", "doubleClick", "button", "modifiers", "delayMs", "timeoutMs"],
    includeSsrf: true,
    mock: pwMocks.clickViaPlaywright,
  },
  close: {
    fields: [],
    mock: pwMocks.closePageViaPlaywright,
  },
  drag: {
    fields: ["startRef", "startSelector", "endRef", "endSelector", "timeoutMs"],
    mock: pwMocks.dragViaPlaywright,
  },
  fill: {
    fields: ["fields", "timeoutMs"],
    mock: pwMocks.fillFormViaPlaywright,
  },
  hover: {
    fields: ["ref", "selector", "timeoutMs"],
    mock: pwMocks.hoverViaPlaywright,
  },
  press: {
    fields: ["key", "delayMs"],
    includeSsrf: true,
    mock: pwMocks.pressKeyViaPlaywright,
  },
  resize: {
    fields: ["width", "height"],
    mock: pwMocks.resizeViewportViaPlaywright,
  },
  scrollIntoView: {
    fields: ["ref", "selector", "timeoutMs"],
    mock: pwMocks.scrollIntoViewViaPlaywright,
  },
  select: {
    fields: ["ref", "selector", "values", "timeoutMs"],
    mock: pwMocks.selectOptionViaPlaywright,
  },
  type: {
    fields: ["ref", "selector", "text", "submit", "slowly", "timeoutMs"],
    includeSsrf: true,
    mock: pwMocks.typeViaPlaywright,
  },
  wait: {
    fields: ["timeMs", "text", "textGone", "selector", "url", "loadState", "fn", "timeoutMs"],
    includeSignal: true,
    mock: pwMocks.waitForViaPlaywright,
  },
};

pwMocks.executeActViaPlaywright.mockImplementation(
  async (opts: ExecuteActMockOptions | undefined) => {
    if (!opts) {
      return {};
    }
    const { cdpUrl, action, targetId, ssrfPolicy, evaluateEnabled, signal } = opts;
    const spec = passThroughActDispatch[action.kind];
    if (spec) {
      await spec.mock(
        buildActPayload({
          action,
          cdpUrl,
          fields: spec.fields,
          includeSignal: spec.includeSignal,
          includeSsrf: spec.includeSsrf,
          signal,
          ssrfPolicy,
          targetId,
        }),
      );
      return {};
    }

    switch (action.kind) {
      case "evaluate": {
        if (!evaluateEnabled) {
          throw new Error("act:evaluate is disabled by config (browser.evaluateEnabled=false)");
        }
        const result = await pwMocks.evaluateViaPlaywright({
          cdpUrl,
          fn: action.fn,
          ref: action.ref,
          signal,
          ssrfPolicy,
          targetId,
          timeoutMs: action.timeoutMs,
        });
        return { result };
      }
      case "batch": {
        const result = await pwMocks.batchViaPlaywright({
          actions: action.actions,
          cdpUrl,
          evaluateEnabled,
          signal,
          ssrfPolicy,
          stopOnError: action.stopOnError,
          targetId,
        });
        return { results: result.results };
      }
      default: {
        return {};
      }
    }
  },
);

export function getPwMocks(): Record<string, MockFn> {
  return pwMocks as unknown as Record<string, MockFn>;
}

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpElement: vi.fn(async () => {}),
  closeChromeMcpSession: vi.fn(async () => true),
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(async () => true),
  fillChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  focusChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
  hoverChromeMcpElement: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", type: "page", url: "https://example.com" },
  ]),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  openChromeMcpTab: vi.fn(async (_profile: string, url: string) => ({
    targetId: "8",
    title: "",
    type: "page",
    url,
  })),
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
  takeChromeMcpScreenshot: vi.fn(async () => Buffer.from("png")),
  takeChromeMcpSnapshot: vi.fn(async () => ({
    children: [{ id: "btn-1", name: "Continue", role: "button" }],
    id: "root",
    name: "Example",
    role: "document",
  })),
  uploadChromeMcpFile: vi.fn(async () => {}),
}));

export function getChromeMcpMocks(): Record<string, MockFn> {
  return chromeMcpMocks as unknown as Record<string, MockFn>;
}

const chromeUserDataDir = vi.hoisted(() => ({ dir: "/tmp/openclaw" }));
installChromeUserDataDirHooks(chromeUserDataDir);

type BrowserServerModule = typeof import("../server.js");
let browserServerModule: BrowserServerModule | null = null;

async function loadBrowserServerModule(): Promise<BrowserServerModule> {
  if (browserServerModule) {
    return browserServerModule;
  }
  vi.resetModules();
  browserServerModule = await import("../server.js");
  return browserServerModule;
}

function makeProc(pid = 123) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    emitExit: () => {
      for (const cb of handlers.get("exit") ?? []) {
        cb(0);
      }
    },
    exitCode: null as number | null,
    kill: () => true,
    killed: false,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      return undefined;
    },
    pid,
  };
}

const proc = makeProc();

function defaultProfilesForState(testPort: number): HarnessState["cfgProfiles"] {
  return {
    openclaw: { cdpPort: testPort + 9, color: "#FF4500" },
  };
}

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const loadConfig = () => ({
    browser: {
      attachOnly: state.cfgAttachOnly,
      color: "#FF4500",
      defaultProfile: state.cfgDefaultProfile,
      enabled: true,
      evaluateEnabled: state.cfgEvaluateEnabled,
      headless: true,
      profiles:
        Object.keys(state.cfgProfiles).length > 0
          ? state.cfgProfiles
          : defaultProfilesForState(state.testPort),
    },
  });
  const writeConfigFile = vi.fn(async () => {});
  return {
    ...actual,
    createConfigIO: vi.fn(() => ({
      loadConfig,
      writeConfigFile,
    })),
    getRuntimeConfigSnapshot: vi.fn(() => null),
    loadConfig,
    writeConfigFile,
  };
});

const launchCalls = vi.hoisted(() => [] as { port: number }[]);

export function getLaunchCalls() {
  return launchCalls;
}

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => state.reachable),
  isChromeReachable: vi.fn(async () => state.reachable),
  launchOpenClawChrome: vi.fn(async (_resolved: unknown, profile: { cdpPort: number }) => {
    launchCalls.push({ port: profile.cdpPort });
    state.reachable = true;
    return {
      cdpPort: profile.cdpPort,
      exe: { kind: "chrome", path: "/fake/chrome" },
      pid: 123,
      proc,
      startedAt: Date.now(),
      userDataDir: chromeUserDataDir.dir,
    };
  }),
  resolveOpenClawUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopOpenClawChrome: vi.fn(async () => {
    state.reachable = false;
  }),
}));

vi.mock("./cdp.js", () => ({
  appendCdpPath: vi.fn((cdpUrl: string, cdpPath: string) => {
    const base = cdpUrl.replace(/\/$/, "");
    const suffix = cdpPath.startsWith("/") ? cdpPath : `/${cdpPath}`;
    return `${base}${suffix}`;
  }),
  createTargetViaCdp: cdpMocks.createTargetViaCdp,
  getHeadersWithAuth: vi.fn(() => ({})),
  normalizeCdpWsUrl: vi.fn((wsUrl: string) => wsUrl),
  snapshotAria: cdpMocks.snapshotAria,
}));

vi.mock("./pw-ai.js", () => pwMocks);

vi.mock("./chrome-mcp.js", () => chromeMcpMocks);

vi.mock("../media/store.js", () => ({
  MEDIA_MAX_BYTES: 5 * 1024 * 1024,
  ensureMediaDir: vi.fn(async () => {}),
  getMediaDir: vi.fn(() => "/tmp"),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buf: Buffer) => ({
    buffer: buf,
    contentType: "image/png",
  })),
}));

export async function startBrowserControlServerFromConfig() {
  const server = await loadBrowserServerModule();
  return await server.startBrowserControlServerFromConfig();
}

export async function stopBrowserControlServer(): Promise<void> {
  const server = browserServerModule;
  browserServerModule = null;
  if (!server) {
    return;
  }
  await server.stopBrowserControlServer();
}

export function makeResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; text?: string },
): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  const text = init?.text ?? "";
  return {
    json: async () => body,
    ok,
    status,
    text: async () => text,
  } as unknown as Response;
}

function mockClearAll(obj: Record<string, { mockClear: () => unknown }>) {
  for (const fn of Object.values(obj)) {
    fn.mockClear();
  }
}

export async function resetBrowserControlServerTestContext(): Promise<void> {
  state.reachable = false;
  state.cfgAttachOnly = false;
  state.cfgEvaluateEnabled = true;
  state.cfgDefaultProfile = "openclaw";
  state.cfgProfiles = defaultProfilesForState(state.testPort);
  state.createTargetId = null;

  mockClearAll(pwMocks);
  mockClearAll(cdpMocks);
  mockClearAll(chromeMcpMocks);

  state.testPort = await getFreePort();
  state.cdpBaseUrl = `http://127.0.0.1:${state.testPort + 9}`;
  state.cfgProfiles = defaultProfilesForState(state.testPort);
  state.prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
  process.env.OPENCLAW_GATEWAY_PORT = String(state.testPort - 2);
  // Avoid flaky auth coupling: some suites temporarily set gateway env auth
  // Which would make the browser control server require auth.
  state.prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  state.prevGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
}

export function restoreGatewayAuthEnv(
  prevGatewayToken: string | undefined,
  prevGatewayPassword: string | undefined,
): void {
  if (prevGatewayToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = prevGatewayToken;
  }
  if (prevGatewayPassword === undefined) {
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  } else {
    process.env.OPENCLAW_GATEWAY_PASSWORD = prevGatewayPassword;
  }
}

export async function cleanupBrowserControlServerTestContext(): Promise<void> {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreGatewayPortEnv(state.prevGatewayPort);
  restoreGatewayAuthEnv(state.prevGatewayToken, state.prevGatewayPassword);
  await stopBrowserControlServer();
}

export function installBrowserControlServerHooks() {
  const hookTimeoutMs = process.platform === "win32" ? 300_000 : 240_000;
  beforeEach(async () => {
    vi.useRealTimers();
    cdpMocks.createTargetViaCdp.mockImplementation(async () => {
      if (state.createTargetId) {
        return { targetId: state.createTargetId };
      }
      throw new Error("cdp disabled");
    });

    await resetBrowserControlServerTestContext();
    await loadBrowserServerModule();

    // Minimal CDP JSON endpoints used by the server.
    let putNewCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/json/list")) {
          if (!state.reachable) {
            return makeResponse([]);
          }
          return makeResponse([
            {
              id: "abcd1234",
              title: "Tab",
              type: "page",
              url: "https://example.com",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/abcd1234",
            },
            {
              id: "abce9999",
              title: "Other",
              type: "page",
              url: "https://other",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/abce9999",
            },
          ]);
        }
        if (u.includes("/json/new?")) {
          if (init?.method === "PUT") {
            putNewCalls += 1;
            if (putNewCalls === 1) {
              return makeResponse({}, { ok: false, status: 405, text: "" });
            }
          }
          return makeResponse({
            id: "newtab1",
            title: "",
            type: "page",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/newtab1",
          });
        }
        if (u.includes("/json/activate/")) {
          return makeResponse("ok");
        }
        if (u.includes("/json/close/")) {
          return makeResponse("ok");
        }
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  }, hookTimeoutMs);

  afterEach(async () => {
    await cleanupBrowserControlServerTestContext();
  });
}
