import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { dashboardCommand } from "./dashboard.js";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  resolveGatewayPort: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  openUrl: vi.fn(),
  resolveControlUiLinks: mocks.resolveControlUiLinks,
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

function mockSnapshot(params?: {
  token?: string;
  bind?: GatewayBindMode;
  customBindHost?: string;
}) {
  const token = params?.token ?? "abc123";
  mocks.readConfigFileSnapshot.mockResolvedValue({
    config: {
      gateway: {
        auth: { token },
        bind: params?.bind,
        customBindHost: params?.customBindHost,
      },
    },
    exists: true,
    issues: [],
    legacyIssues: [],
    parsed: {},
    path: "/tmp/openclaw.json",
    raw: "{}",
    valid: true,
  });
  mocks.resolveGatewayPort.mockReturnValue(18_789);
  mocks.resolveControlUiLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  mocks.copyToClipboard.mockResolvedValue(true);
}

describe("dashboardCommand bind selection", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.resolveGatewayPort.mockClear();
    mocks.resolveControlUiLinks.mockClear();
    mocks.copyToClipboard.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it.each([
    { label: "maps lan bind to loopback", snapshot: { bind: "lan" as const } },
    { label: "defaults unset bind to loopback", snapshot: undefined },
  ])("$label for dashboard URLs", async ({ snapshot }) => {
    mockSnapshot(snapshot);

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      basePath: undefined,
      bind: "loopback",
      customBindHost: undefined,
      port: 18_789,
    });
  });

  it("preserves custom bind mode", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      basePath: undefined,
      bind: "custom",
      customBindHost: "10.0.0.5",
      port: 18_789,
    });
  });

  it("preserves tailnet bind mode", async () => {
    mockSnapshot({ bind: "tailnet" });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      basePath: undefined,
      bind: "tailnet",
      customBindHost: undefined,
      port: 18_789,
    });
  });
});
