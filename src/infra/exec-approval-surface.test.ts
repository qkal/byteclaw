import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const listChannelPluginsMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
    listChannelPlugins: (...args: unknown[]) => listChannelPluginsMock(...args),
  };
});

vi.mock("../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "web",
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
}));

type ExecApprovalSurfaceModule = typeof import("./exec-approval-surface.js");

let resolveExecApprovalInitiatingSurfaceState: ExecApprovalSurfaceModule["resolveExecApprovalInitiatingSurfaceState"];
let supportsNativeExecApprovalClient: ExecApprovalSurfaceModule["supportsNativeExecApprovalClient"];

describe("resolveExecApprovalInitiatingSurfaceState", () => {
  beforeAll(async () => {
    ({ resolveExecApprovalInitiatingSurfaceState, supportsNativeExecApprovalClient } =
      await import("./exec-approval-surface.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    getChannelPluginMock.mockReset();
    listChannelPluginsMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation(
      (value?: string) => value === "slack" || value === "discord" || value === "telegram",
    );
  });

  it.each([
    {
      channel: null,
      expected: {
        accountId: undefined,
        channel: undefined,
        channelLabel: "this platform",
        kind: "enabled",
      },
    },
    {
      channel: "tui",
      expected: {
        accountId: undefined,
        channel: "tui",
        channelLabel: "terminal UI",
        kind: "enabled",
      },
    },
    {
      channel: "web",
      expected: {
        accountId: undefined,
        channel: "web",
        channelLabel: "Web UI",
        kind: "enabled",
      },
    },
  ])("treats built-in initiating surface %j", ({ channel, expected }) => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel })).toEqual(expected);
  });

  it("uses the provided cfg for telegram and discord client enablement", () => {
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            approvalCapability: {
              getActionAvailabilityState: () => ({ kind: "enabled" }),
            },
            meta: { label: "Telegram" },
          }
        : channel === "discord"
          ? {
              approvalCapability: {
                getActionAvailabilityState: () => ({ kind: "disabled" }),
              },
              meta: { label: "Discord" },
            }
          : undefined,
    );
    const cfg = { channels: {} };

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        accountId: "main",
        cfg: cfg as never,
        channel: "telegram",
      }),
    ).toEqual({
      accountId: "main",
      channel: "telegram",
      channelLabel: "Telegram",
      kind: "enabled",
    });
    expect(
      resolveExecApprovalInitiatingSurfaceState({
        accountId: "main",
        cfg: cfg as never,
        channel: "discord",
      }),
    ).toEqual({
      accountId: "main",
      channel: "discord",
      channelLabel: "Discord",
      kind: "disabled",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("reads approval availability from approvalCapability when auth is omitted", () => {
    const getActionAvailabilityState = vi.fn(() => ({ kind: "disabled" as const }));
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        getActionAvailabilityState,
      },
      meta: { label: "Discord" },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        accountId: "main",
        cfg: {} as never,
        channel: "discord",
      }),
    ).toEqual({
      accountId: "main",
      channel: "discord",
      channelLabel: "Discord",
      kind: "disabled",
    });
    expect(getActionAvailabilityState).toHaveBeenCalledWith({
      accountId: "main",
      action: "approve",
      approvalKind: "exec",
      cfg: {} as never,
    });
  });

  it("prefers exec-initiating-surface state over generic approval availability", () => {
    const getExecInitiatingSurfaceState = vi.fn(() => ({ kind: "disabled" as const }));
    const getActionAvailabilityState = vi.fn(() => ({ kind: "enabled" as const }));
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        getActionAvailabilityState,
        getExecInitiatingSurfaceState,
        native: {},
      },
      meta: { label: "Matrix" },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        accountId: "default",
        cfg: {} as never,
        channel: "matrix",
      }),
    ).toEqual({
      accountId: "default",
      channel: "matrix",
      channelLabel: "Matrix",
      kind: "disabled",
    });
    expect(getExecInitiatingSurfaceState).toHaveBeenCalledWith({
      accountId: "default",
      action: "approve",
      cfg: {} as never,
    });
    expect(getActionAvailabilityState).not.toHaveBeenCalled();
  });

  it("does not treat plugin-only approval availability as exec availability", () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        getActionAvailabilityState: ({ approvalKind }: { approvalKind?: "exec" | "plugin" }) =>
          approvalKind === "plugin" ? { kind: "enabled" as const } : { kind: "disabled" as const },
        native: {},
      },
      meta: { label: "Matrix" },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        accountId: "default",
        cfg: {} as never,
        channel: "matrix",
      }),
    ).toEqual({
      accountId: "default",
      channel: "matrix",
      channelLabel: "Matrix",
      kind: "disabled",
    });
  });

  it("loads config lazily when cfg is omitted and marks unsupported channels", () => {
    loadConfigMock.mockReturnValueOnce({ loaded: true });
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            approvalCapability: {
              getActionAvailabilityState: () => ({ kind: "disabled" }),
            },
            meta: { label: "Telegram" },
          }
        : undefined,
    );

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        accountId: "main",
        channel: "telegram",
      }),
    ).toEqual({
      accountId: "main",
      channel: "telegram",
      channelLabel: "Telegram",
      kind: "disabled",
    });
    expect(loadConfigMock).toHaveBeenCalledOnce();

    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "signal" })).toEqual({
      accountId: undefined,
      channel: "signal",
      channelLabel: "Signal",
      kind: "unsupported",
    });
  });

  it("treats deliverable chat channels without a custom adapter as enabled", () => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "slack" })).toEqual({
      accountId: undefined,
      channel: "slack",
      channelLabel: "Slack",
      kind: "enabled",
    });
  });

  it("treats exec-specific initiating-surface hooks as native exec client support", () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        getExecInitiatingSurfaceState: () => ({ kind: "enabled" as const }),
        native: {},
      },
      meta: { label: "Matrix" },
    });

    expect(supportsNativeExecApprovalClient("matrix")).toBe(true);
  });
});
