import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSecurityCli } from "./security-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    log: vi.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
  };
  return {
    defaultRuntime,
    fixSecurityFootguns: vi.fn(),
    getSecurityAuditCommandSecretTargetIds: vi.fn(
      () => new Set(["gateway.auth.token", "gateway.auth.password"]),
    ),
    loadConfig: vi.fn(),
    resolveCommandSecretRefsViaGateway: vi.fn(),
    runSecurityAudit: vi.fn(),
    runtimeLogs,
  };
});

const {
  loadConfig,
  runSecurityAudit,
  fixSecurityFootguns,
  resolveCommandSecretRefsViaGateway,
  getSecurityAuditCommandSecretTargetIds,
  runtimeLogs,
} = mocks;

vi.mock("../config/config.js", () => ({
  loadConfig: () => mocks.loadConfig(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../security/audit.js", () => ({
  runSecurityAudit: (opts: unknown) => mocks.runSecurityAudit(opts),
}));

vi.mock("../security/fix.js", () => ({
  fixSecurityFootguns: () => mocks.fixSecurityFootguns(),
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (opts: unknown) =>
    mocks.resolveCommandSecretRefsViaGateway(opts),
}));

vi.mock("./command-secret-targets.js", () => ({
  getSecurityAuditCommandSecretTargetIds: () => mocks.getSecurityAuditCommandSecretTargetIds(),
}));

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerSecurityCli(program);
  return program;
}

function primeDeepAuditConfig(sourceConfig = { gateway: { mode: "local" } }) {
  loadConfig.mockReturnValue(sourceConfig);
  resolveCommandSecretRefsViaGateway.mockResolvedValue({
    diagnostics: [],
    hadUnresolvedTargets: false,
    resolvedConfig: sourceConfig,
    targetStatesByPath: {},
  });
  runSecurityAudit.mockResolvedValue({
    findings: [],
    summary: { critical: 0, info: 0, warn: 0 },
    ts: 0,
  });
  return sourceConfig;
}

describe("security CLI", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    loadConfig.mockReset();
    runSecurityAudit.mockReset();
    fixSecurityFootguns.mockReset();
    resolveCommandSecretRefsViaGateway.mockReset();
    getSecurityAuditCommandSecretTargetIds.mockClear();
    fixSecurityFootguns.mockResolvedValue({
      actions: [],
      changes: [],
      errors: [],
    });
  });

  it("runs audit with read-only SecretRef resolution and prints JSON diagnostics", async () => {
    const sourceConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { id: "OPENCLAW_GATEWAY_TOKEN", provider: "default", source: "env" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    const resolvedConfig = {
      ...sourceConfig,
      gateway: {
        ...sourceConfig.gateway,
        auth: {
          ...sourceConfig.gateway.auth,
          token: "resolved-token",
        },
      },
    };
    loadConfig.mockReturnValue(sourceConfig);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      diagnostics: [
        "security audit: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
      ],
      hadUnresolvedTargets: false,
      resolvedConfig,
      targetStatesByPath: {},
    });
    runSecurityAudit.mockResolvedValue({
      findings: [
        {
          checkId: "gateway.probe_failed",
          detail: "connect failed: connect ECONNREFUSED 127.0.0.1:18789",
          severity: "warn",
          title: "Gateway probe failed (deep)",
        },
      ],
      summary: { critical: 0, info: 0, warn: 1 },
      ts: 0,
    });

    await createProgram().parseAsync(["security", "audit", "--json"], { from: "user" });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "security audit",
        config: sourceConfig,
        mode: "read_only_status",
        targetIds: expect.any(Set),
      }),
    );
    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        deep: false,
        includeChannelSecurity: true,
        includeFilesystem: true,
        sourceConfig,
      }),
    );
    const payload = JSON.parse(String(runtimeLogs.at(-1)));
    expect(payload.secretDiagnostics).toEqual([
      "security audit: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
    ]);
  });

  it.each([
    {
      argv: ["--token", "explicit-token"],
      deepProbeAuth: { token: "explicit-token" },
      title: "forwards --token to deep probe auth without altering command-level resolver mode",
    },
    {
      argv: ["--password", "explicit-password"],
      deepProbeAuth: { password: "explicit-password" },
      title: "forwards --password to deep probe auth without altering command-level resolver mode",
    },
    {
      argv: ["--token", "explicit-token", "--password", "explicit-password"],
      deepProbeAuth: {
        password: "explicit-password",
        token: "explicit-token",
      },
      title: "forwards both --token and --password to deep probe auth",
    },
  ])("$title", async ({ argv, deepProbeAuth }) => {
    primeDeepAuditConfig();

    await createProgram().parseAsync(["security", "audit", "--deep", ...argv, "--json"], {
      from: "user",
    });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "read_only_status",
      }),
    );
    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        deep: true,
        deepProbeAuth,
      }),
    );
  });
});
