import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { channelsStatusCommand } from "./channels/status.js";

const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;

const callGateway = vi.fn();
const resolveCommandSecretRefsViaGateway = vi.fn();
const requireValidConfigSnapshot = vi.fn();
const listChannelPlugins = vi.fn();
const withProgress = vi.fn(async (_opts: unknown, run: () => Promise<unknown>) => await run());

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (opts: unknown) => resolveCommandSecretRefsViaGateway(opts),
}));

vi.mock("./shared.js", () => ({
  formatChannelAccountLabel: ({
    channel,
    accountId,
  }: {
    channel: string;
    accountId: string;
    name?: string;
  }) => `${channel} ${accountId}`,
  requireValidConfigSnapshot: (runtime: unknown) => requireValidConfigSnapshot(runtime),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (channel: string) =>
    (listChannelPlugins() as { id: string }[]).find((plugin) => plugin.id === channel),
  listChannelPlugins: () => listChannelPlugins(),
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: (opts: unknown, run: () => Promise<unknown>) => withProgress(opts, run),
}));

function createTokenOnlyPlugin() {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      defaultAccountId: resolveDefaultAccountId,
      inspectAccount: (cfg: { secretResolved?: boolean }) =>
        cfg.secretResolved
          ? {
              configured: true,
              enabled: true,
              name: "Primary",
              token: "resolved-discord-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : {
              configured: true,
              enabled: true,
              name: "Primary",
              token: "",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            },
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["default"],
      resolveAccount: (cfg: { secretResolved?: boolean }) =>
        cfg.secretResolved
          ? {
              configured: true,
              enabled: true,
              name: "Primary",
              token: "resolved-discord-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : {
              configured: true,
              enabled: true,
              name: "Primary",
              token: "",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            },
    },
    id: "discord",
    meta: {
      blurb: "test",
      docsPath: "/channels/discord",
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
    },
  };
}

function createRuntimeCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    error: (message: unknown) => errors.push(String(message)),
    exit: (_code?: number) => undefined,
    log: (message: unknown) => logs.push(String(message)),
  };
  return { errors, logs, runtime };
}

describe("channelsStatusCommand SecretRef fallback flow", () => {
  beforeEach(() => {
    callGateway.mockReset();
    resolveCommandSecretRefsViaGateway.mockReset();
    requireValidConfigSnapshot.mockReset();
    listChannelPlugins.mockReset();
    withProgress.mockClear();
    listChannelPlugins.mockReturnValue([createTokenOnlyPlugin()]);
  });

  it("keeps read-only fallback output when SecretRefs are unresolved", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed"));
    requireValidConfigSnapshot.mockResolvedValue({ channels: {}, secretResolved: false });
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      diagnostics: [
        "channels status: channels.discord.token is unavailable in this command path; continuing with degraded read-only config.",
      ],
      hadUnresolvedTargets: true,
      resolvedConfig: { channels: {}, secretResolved: false },
      targetStatesByPath: {},
    });
    const { runtime, logs, errors } = createRuntimeCapture();

    await channelsStatusCommand({ probe: false }, runtime as never);

    expect(errors.some((line) => line.includes("Gateway not reachable"))).toBe(true);
    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "channels status",
        mode: "read_only_status",
      }),
    );
    expect(
      logs.some((line) =>
        line.includes("[secrets] channels status: channels.discord.token is unavailable"),
      ),
    ).toBe(true);
    const joined = logs.join("\n");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });

  it("prefers resolved snapshots when command-local SecretRef resolution succeeds", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed"));
    requireValidConfigSnapshot.mockResolvedValue({ channels: {}, secretResolved: false });
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      diagnostics: [],
      hadUnresolvedTargets: false,
      resolvedConfig: { channels: {}, secretResolved: true },
      targetStatesByPath: {},
    });
    const { runtime, logs } = createRuntimeCapture();

    await channelsStatusCommand({ probe: false }, runtime as never);

    const joined = logs.join("\n");
    expect(joined).toContain("configured");
    expect(joined).toContain("token:config");
    expect(joined).not.toContain("secret unavailable in this command path");
    expect(joined).not.toContain("token:config (unavailable)");
  });
});
