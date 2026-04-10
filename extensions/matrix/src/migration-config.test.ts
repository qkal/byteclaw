import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import { resolveMatrixMigrationAccountTarget } from "./migration-config.js";
import {
  MATRIX_OPS_ACCESS_TOKEN,
  MATRIX_OPS_ACCOUNT_ID,
  MATRIX_OPS_USER_ID,
  MATRIX_TEST_HOMESERVER,
  writeMatrixCredentials,
} from "./test-helpers.js";

function resolveOpsTarget(cfg: OpenClawConfig, env = process.env) {
  return resolveMatrixMigrationAccountTarget({
    accountId: MATRIX_OPS_ACCOUNT_ID,
    cfg,
    env,
  });
}

describe("resolveMatrixMigrationAccountTarget", () => {
  it("reuses stored user identity for token-only configs when the access token matches", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeMatrixCredentials(stateDir, {
        accessToken: MATRIX_OPS_ACCESS_TOKEN,
        accountId: MATRIX_OPS_ACCOUNT_ID,
        deviceId: "DEVICE-OPS",
      });

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                accessToken: MATRIX_OPS_ACCESS_TOKEN,
                homeserver: MATRIX_TEST_HOMESERVER,
              },
            },
          },
        },
      };

      const target = resolveOpsTarget(cfg);

      expect(target).not.toBeNull();
      expect(target?.userId).toBe(MATRIX_OPS_USER_ID);
      expect(target?.storedDeviceId).toBe("DEVICE-OPS");
    });
  });

  it("ignores stored device IDs from stale cached Matrix credentials", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeMatrixCredentials(stateDir, {
        accessToken: "tok-old",
        accountId: MATRIX_OPS_ACCOUNT_ID,
        deviceId: "DEVICE-OLD",
        userId: "@old-bot:example.org",
      });

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                accessToken: "tok-new",
                homeserver: MATRIX_TEST_HOMESERVER,
                userId: "@new-bot:example.org",
              },
            },
          },
        },
      };

      const target = resolveOpsTarget(cfg);

      expect(target).not.toBeNull();
      expect(target?.userId).toBe("@new-bot:example.org");
      expect(target?.accessToken).toBe("tok-new");
      expect(target?.storedDeviceId).toBeNull();
    });
  });

  it("does not trust stale stored creds on the same homeserver when the token changes", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeMatrixCredentials(stateDir, {
        accessToken: "tok-old",
        accountId: MATRIX_OPS_ACCOUNT_ID,
        deviceId: "DEVICE-OLD",
        userId: "@old-bot:example.org",
      });

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                accessToken: "tok-new",
                homeserver: MATRIX_TEST_HOMESERVER,
              },
            },
          },
        },
      };

      const target = resolveOpsTarget(cfg);

      expect(target).toBeNull();
    });
  });

  it("does not inherit the base userId for non-default token-only accounts", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeMatrixCredentials(stateDir, {
        accessToken: MATRIX_OPS_ACCESS_TOKEN,
        accountId: MATRIX_OPS_ACCOUNT_ID,
        deviceId: "DEVICE-OPS",
      });

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                accessToken: MATRIX_OPS_ACCESS_TOKEN,
                homeserver: MATRIX_TEST_HOMESERVER,
              },
            },
            homeserver: MATRIX_TEST_HOMESERVER,
            userId: "@base-bot:example.org",
          },
        },
      };

      const target = resolveOpsTarget(cfg);

      expect(target).not.toBeNull();
      expect(target?.userId).toBe(MATRIX_OPS_USER_ID);
      expect(target?.storedDeviceId).toBe("DEVICE-OPS");
    });
  });

  it("does not inherit the base access token for non-default accounts", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accessToken: "tok-base",
            accounts: {
              ops: {
                homeserver: MATRIX_TEST_HOMESERVER,
                userId: MATRIX_OPS_USER_ID,
              },
            },
            homeserver: MATRIX_TEST_HOMESERVER,
            userId: "@base-bot:example.org",
          },
        },
      };

      const target = resolveOpsTarget(cfg);

      expect(target).toBeNull();
    });
  });

  it("does not inherit the global Matrix access token for non-default accounts", async () => {
    await withTempHome(
      async () => {
        const cfg: OpenClawConfig = {
          channels: {
            matrix: {
              accounts: {
                ops: {
                  homeserver: MATRIX_TEST_HOMESERVER,
                  userId: MATRIX_OPS_USER_ID,
                },
              },
            },
          },
        };

        const target = resolveOpsTarget(cfg);

        expect(target).toBeNull();
      },
      {
        env: {
          MATRIX_ACCESS_TOKEN: "tok-global",
        },
      },
    );
  });

  it("uses the same scoped env token encoding as runtime account auth", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              "ops-prod": {},
            },
          },
        },
      };
      const env = {
        MATRIX_OPS_X2D_PROD_ACCESS_TOKEN: "tok-ops-prod",
        MATRIX_OPS_X2D_PROD_HOMESERVER: "https://matrix.example.org",
        MATRIX_OPS_X2D_PROD_USER_ID: "@ops-prod:example.org",
      } as NodeJS.ProcessEnv;

      const target = resolveMatrixMigrationAccountTarget({
        accountId: "ops-prod",
        cfg,
        env,
      });

      expect(target).not.toBeNull();
      expect(target?.homeserver).toBe("https://matrix.example.org");
      expect(target?.userId).toBe("@ops-prod:example.org");
      expect(target?.accessToken).toBe("tok-ops-prod");
    });
  });
});
