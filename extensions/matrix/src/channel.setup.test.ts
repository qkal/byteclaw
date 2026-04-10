import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";

const verificationMocks = vi.hoisted(() => ({
  bootstrapMatrixVerification: vi.fn(),
}));

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: verificationMocks.bootstrapMatrixVerification,
}));

import { matrixConfigAdapter } from "./config-adapter.js";
import { runMatrixSetupBootstrapAfterConfigWrite } from "./setup-bootstrap.js";
import { matrixSetupAdapter } from "./setup-core.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

describe("matrix setup post-write bootstrap", () => {
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
  const encryptedDefaultCfg = {
    channels: {
      matrix: {
        encryption: true,
      },
    },
  } as CoreConfig;
  const defaultPasswordInput = {
    homeserver: "https://matrix.example.org",
    password: "secret",
    userId: "@flurry:example.org", // Pragma: allowlist secret
  } as const;
  const runtime: RuntimeEnv = {
    error,
    exit,
    log,
  };

  function applyAccountConfig(params: {
    previousCfg: CoreConfig;
    accountId: string;
    input: Record<string, unknown>;
  }) {
    return {
      accountId: params.accountId,
      input: params.input,
      nextCfg: matrixSetupAdapter.applyAccountConfig({
        accountId: params.accountId,
        cfg: params.previousCfg,
        input: params.input,
      }) as CoreConfig,
      previousCfg: params.previousCfg,
    };
  }

  function applyDefaultAccountConfig(input: Record<string, unknown> = defaultPasswordInput) {
    return applyAccountConfig({
      accountId: "default",
      input,
      previousCfg: encryptedDefaultCfg,
    });
  }

  function mockBootstrapResult(params: {
    success: boolean;
    backupVersion?: string | null;
    error?: string;
  }) {
    verificationMocks.bootstrapMatrixVerification.mockResolvedValue({
      success: params.success,
      ...(params.error ? { error: params.error } : {}),
      verification: {
        backupVersion: params.backupVersion ?? null,
      },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });
  }

  async function runAfterAccountConfigWritten(params: {
    previousCfg: CoreConfig;
    nextCfg: CoreConfig;
    accountId: string;
    input: Record<string, unknown>;
  }) {
    await runMatrixSetupBootstrapAfterConfigWrite({
      accountId: params.accountId,
      cfg: params.nextCfg,
      previousCfg: params.previousCfg,
      runtime,
    });
  }

  async function withSavedEnv<T>(
    values: Record<string, string | undefined>,
    run: () => Promise<T> | T,
  ) {
    const previousEnv = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    ) as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      return await run();
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  beforeEach(() => {
    verificationMocks.bootstrapMatrixVerification.mockReset();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    installMatrixTestRuntime();
  });

  it("bootstraps verification for newly added encrypted accounts", async () => {
    const { previousCfg, nextCfg, accountId, input } = applyDefaultAccountConfig();
    mockBootstrapResult({ backupVersion: "7", success: true });

    await runAfterAccountConfigWritten({ accountId, input, nextCfg, previousCfg });

    expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
      accountId: "default",
    });
    expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
    expect(log).toHaveBeenCalledWith('Matrix backup version for "default": 7');
    expect(error).not.toHaveBeenCalled();
  });

  it("does not bootstrap verification for already configured accounts", async () => {
    const previousCfg = {
      channels: {
        matrix: {
          accounts: {
            flurry: {
              accessToken: "token",
              encryption: true,
              homeserver: "https://matrix.example.org",
              userId: "@flurry:example.org",
            },
          },
        },
      },
    } as CoreConfig;
    const input = {
      accessToken: "new-token",
      homeserver: "https://matrix.example.org",
      userId: "@flurry:example.org",
    };
    const { nextCfg, accountId } = applyAccountConfig({
      accountId: "flurry",
      input,
      previousCfg,
    });

    await runAfterAccountConfigWritten({ accountId, input, nextCfg, previousCfg });

    expect(verificationMocks.bootstrapMatrixVerification).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs a warning when verification bootstrap fails", async () => {
    const { previousCfg, nextCfg, accountId, input } = applyDefaultAccountConfig();
    mockBootstrapResult({
      error: "no room-key backup exists on the homeserver",
      success: false,
    });

    await runAfterAccountConfigWritten({ accountId, input, nextCfg, previousCfg });

    expect(error).toHaveBeenCalledWith(
      'Matrix verification bootstrap warning for "default": no room-key backup exists on the homeserver',
    );
  });

  it("bootstraps a newly added env-backed default account when encryption is already enabled", async () => {
    await withSavedEnv(
      {
        MATRIX_ACCESS_TOKEN: "env-token",
        MATRIX_HOMESERVER: "https://matrix.example.org",
      },
      async () => {
        const { previousCfg, nextCfg, accountId, input } = applyDefaultAccountConfig({
          useEnv: true,
        });
        mockBootstrapResult({ backupVersion: "9", success: true });

        await runAfterAccountConfigWritten({ accountId, input, nextCfg, previousCfg });

        expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
          accountId: "default",
        });
        expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
      },
    );
  });

  it("rejects default useEnv setup when no Matrix auth env vars are available", () => withSavedEnv(
      {
        MATRIX_ACCESS_TOKEN: undefined,
        MATRIX_DEFAULT_ACCESS_TOKEN: undefined,
        MATRIX_DEFAULT_HOMESERVER: undefined,
        MATRIX_DEFAULT_PASSWORD: undefined,
        MATRIX_DEFAULT_USER_ID: undefined,
        MATRIX_HOMESERVER: undefined,
        MATRIX_PASSWORD: undefined,
        MATRIX_USER_ID: undefined,
      },
      () => {
        expect(
          matrixSetupAdapter.validateInput?.({
            accountId: "default",
            cfg: {} as CoreConfig,
            input: { useEnv: true },
          }),
        ).toContain("Set Matrix env vars for the default account");
      },
    ));

  it("clears allowPrivateNetwork and proxy when deleting the default Matrix account config", () => {
    const updated = matrixConfigAdapter.deleteAccount?.({
      accountId: "default",
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {
                enabled: true,
              },
            },
            homeserver: "http://localhost.localdomain:8008",
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            proxy: "http://127.0.0.1:7890",
          },
        },
      } as CoreConfig,
    }) as CoreConfig;

    expect(updated.channels?.matrix).toEqual({
      accounts: {
        ops: {
          enabled: true,
        },
      },
    });
  });
});
