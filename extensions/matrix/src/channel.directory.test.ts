import { beforeEach, describe, expect, it } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { RuntimeEnv } from "../runtime-api.js";
import { matrixPlugin } from "./channel.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { resolveMatrixConfigForAccount } from "./matrix/client/config.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

describe("matrix directory", () => {
  const runtimeEnv: RuntimeEnv = createRuntimeEnv();

  beforeEach(() => {
    installMatrixTestRuntime();
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["matrix:@alice:example.org", "bob"] },
          groupAllowFrom: ["@dana:example.org"],
          groups: {
            "!room1:example.org": { users: ["@carol:example.org"] },
            "#alias:example.org": { users: [] },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.directory).toBeTruthy();
    expect(matrixPlugin.directory?.listPeers).toBeTruthy();
    expect(matrixPlugin.directory?.listGroups).toBeTruthy();

    await expect(
      matrixPlugin.directory!.listPeers!({
        accountId: undefined,
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "user:@alice:example.org", kind: "user" },
        { id: "bob", kind: "user", name: "incomplete id; expected @user:server" },
        { id: "user:@carol:example.org", kind: "user" },
        { id: "user:@dana:example.org", kind: "user" },
      ]),
    );

    await expect(
      matrixPlugin.directory!.listGroups!({
        accountId: undefined,
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "room:!room1:example.org", kind: "group" },
        { id: "#alias:example.org", kind: "group" },
      ]),
    );
  });

  it("resolves replyToMode from account config", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            Assistant: {
              replyToMode: "all",
            },
          },
          replyToMode: "off",
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.threading?.resolveReplyToMode).toBeTruthy();
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        accountId: "assistant",
        cfg,
        chatType: "direct",
      }),
    ).toBe("all");
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        accountId: "default",
        cfg,
        chatType: "direct",
      }),
    ).toBe("off");
  });

  it("only exposes real Matrix thread ids in tool context", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          ReplyToId: "$reply",
          To: "room:!room:example.org",
        },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "room:!room:example.org",
      currentThreadTs: undefined,
      hasRepliedRef: { value: false },
    });

    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          MessageThreadId: "$thread",
          ReplyToId: "$reply",
          To: "room:!room:example.org",
        },
        hasRepliedRef: { value: true },
      }),
    ).toEqual({
      currentChannelId: "room:!room:example.org",
      currentThreadTs: "$thread",
      hasRepliedRef: { value: true },
    });
  });

  it("exposes Matrix direct user id in dm tool context", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          ChatType: "direct",
          From: "matrix:@alice:example.org",
          MessageThreadId: "$thread",
          To: "room:!dm:example.org",
        },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "room:!dm:example.org",
      currentDirectUserId: "@alice:example.org",
      currentThreadTs: "$thread",
      hasRepliedRef: { value: false },
    });
  });

  it("accepts raw room ids when inferring Matrix direct user ids", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          ChatType: "direct",
          From: "user:@alice:example.org",
          To: "!dm:example.org",
        },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "!dm:example.org",
      currentDirectUserId: "@alice:example.org",
      currentThreadTs: undefined,
      hasRepliedRef: { value: false },
    });
  });

  it("resolves group mention policy from account config", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            Assistant: {
              groups: {
                "!room:example.org": { requireMention: false },
              },
            },
          },
          groups: {
            "!room:example.org": { requireMention: true },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.groups!.resolveRequireMention!({ cfg, groupId: "!room:example.org" })).toBe(
      true,
    );
    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        accountId: "assistant",
        cfg,
        groupId: "!room:example.org",
      }),
    ).toBe(false);

    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        accountId: "assistant",
        cfg,
        groupId: "matrix:room:!room:example.org",
      }),
    ).toBe(false);
  });

  it("matches prefixed Matrix aliases in group context", () => {
    const cfg = {
      channels: {
        matrix: {
          groups: {
            "#ops:example.org": { requireMention: false },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        groupChannel: "matrix:channel:#ops:example.org",
        groupId: "matrix:room:!room:example.org",
      }),
    ).toBe(false);
  });

  it("reports room access warnings against the active Matrix config path", () => {
    expect(
      matrixPlugin.security?.collectWarnings?.({
        account: resolveMatrixAccount({
          accountId: "default",
          cfg: {
            channels: {
              matrix: {
                groupPolicy: "open",
              },
            },
          } as CoreConfig,
        }),
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "open",
            },
          },
        } as CoreConfig,
      }),
    ).toEqual([
      '- Matrix rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set channels.matrix.groupPolicy="allowlist" + channels.matrix.groups (and optionally channels.matrix.groupAllowFrom) to restrict rooms.',
    ]);

    expect(
      matrixPlugin.security?.collectWarnings?.({
        account: resolveMatrixAccount({
          accountId: "assistant",
          cfg: {
            channels: {
              matrix: {
                defaultAccount: "assistant",
                accounts: {
                  assistant: {
                    groupPolicy: "open",
                  },
                },
              },
            },
          } as CoreConfig,
        }),
        cfg: {
          channels: {
            matrix: {
              accounts: {
                assistant: {
                  groupPolicy: "open",
                },
              },
              defaultAccount: "assistant",
            },
          },
        } as CoreConfig,
      }),
    ).toEqual([
      '- Matrix rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set channels.matrix.accounts.assistant.groupPolicy="allowlist" + channels.matrix.accounts.assistant.groups (and optionally channels.matrix.accounts.assistant.groupAllowFrom) to restrict rooms.',
    ]);
  });

  it("reports invite auto-join warnings only when explicitly enabled", () => {
    expect(
      matrixPlugin.security?.collectWarnings?.({
        account: resolveMatrixAccount({
          accountId: "default",
          cfg: {
            channels: {
              matrix: {
                groupPolicy: "allowlist",
                autoJoin: "always",
              },
            },
          } as CoreConfig,
        }),
        cfg: {
          channels: {
            matrix: {
              autoJoin: "always",
              groupPolicy: "allowlist",
            },
          },
        } as CoreConfig,
      }),
    ).toEqual([
      '- Matrix invites: autoJoin="always" joins any invited room before message policy applies. Set channels.matrix.autoJoin="allowlist" + channels.matrix.autoJoinAllowlist (or channels.matrix.autoJoin="off") to restrict joins.',
    ]);
  });

  it("writes matrix non-default account credentials under channels.matrix.accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "default-token",
          avatarUrl: "mxc://server/avatar",
          deviceId: "DEFAULTDEVICE",
          encryption: true,
          groups: {
            "!room:example.org": { requireMention: true },
          },
          homeserver: "https://default.example.org",
          threadReplies: "inbound",
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      accountId: "ops",
      cfg,
      input: {
        accessToken: "ops-token",
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix"]?.accessToken).toBeUndefined();
    expect(updated.channels?.["matrix"]?.deviceId).toBeUndefined();
    expect(updated.channels?.["matrix"]?.avatarUrl).toBeUndefined();
    expect(updated.channels?.["matrix"]?.accounts?.default).toMatchObject({
      accessToken: "default-token",
      avatarUrl: "mxc://server/avatar",
      deviceId: "DEFAULTDEVICE",
      encryption: true,
      groups: {
        "!room:example.org": { requireMention: true },
      },
      homeserver: "https://default.example.org",
      threadReplies: "inbound",
    });
    expect(updated.channels?.["matrix"]?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
    });
    expect(resolveMatrixConfigForAccount(updated, "ops", {})).toMatchObject({
      accessToken: "ops-token",
      deviceId: undefined,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
    });
  });

  it("writes default matrix account credentials under channels.matrix.accounts.default", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "legacy-token",
          homeserver: "https://legacy.example.org",
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      accountId: "default",
      cfg,
      input: {
        accessToken: "bot-token",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix"]).toMatchObject({
      accessToken: "bot-token",
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
    });
    expect(updated.channels?.["matrix"]?.accounts).toBeUndefined();
  });

  it("requires account-scoped env vars when --use-env is set for non-default accounts", () => {
    const envKeys = [
      "MATRIX_OPS_HOMESERVER",
      "MATRIX_OPS_USER_ID",
      "MATRIX_OPS_ACCESS_TOKEN",
      "MATRIX_OPS_PASSWORD",
    ] as const;
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    for (const key of envKeys) {
      delete process.env[key];
    }
    try {
      const error = matrixPlugin.setup!.validateInput?.({
        accountId: "ops",
        cfg: {} as CoreConfig,
        input: { useEnv: true },
      });
      expect(error).toBe(
        'Set per-account env vars for "ops" (for example MATRIX_OPS_HOMESERVER + MATRIX_OPS_ACCESS_TOKEN or MATRIX_OPS_USER_ID + MATRIX_OPS_PASSWORD).',
      );
    } finally {
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousEnv[key];
        }
      }
    }
  });

  it("accepts --use-env for non-default account when scoped env vars are present", () => {
    const envKeys = {
      MATRIX_OPS_ACCESS_TOKEN: process.env.MATRIX_OPS_ACCESS_TOKEN,
      MATRIX_OPS_HOMESERVER: process.env.MATRIX_OPS_HOMESERVER,
    };
    process.env.MATRIX_OPS_HOMESERVER = "https://ops.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-token";
    try {
      const error = matrixPlugin.setup!.validateInput?.({
        accountId: "ops",
        cfg: {} as CoreConfig,
        input: { useEnv: true },
      });
      expect(error).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(envKeys)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("clears stored auth fields when switching a Matrix account to env-backed auth", () => {
    const envKeys = {
      MATRIX_OPS_ACCESS_TOKEN: process.env.MATRIX_OPS_ACCESS_TOKEN,
      MATRIX_OPS_DEVICE_ID: process.env.MATRIX_OPS_DEVICE_ID,
      MATRIX_OPS_DEVICE_NAME: process.env.MATRIX_OPS_DEVICE_NAME,
      MATRIX_OPS_HOMESERVER: process.env.MATRIX_OPS_HOMESERVER,
    };
    process.env.MATRIX_OPS_HOMESERVER = "https://ops.env.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";
    process.env.MATRIX_OPS_DEVICE_ID = "OPSENVDEVICE";
    process.env.MATRIX_OPS_DEVICE_NAME = "Ops Env Device";

    try {
      const cfg = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: "https://ops.inline.example.org",
                userId: "@ops:inline.example.org",
                accessToken: "ops-inline-token",
                password: "ops-inline-password", // Pragma: allowlist secret
                deviceId: "OPSINLINEDEVICE",
                deviceName: "Ops Inline Device",
                encryption: true,
              },
            },
          },
        },
      } as unknown as CoreConfig;

      const updated = matrixPlugin.setup!.applyAccountConfig({
        accountId: "ops",
        cfg,
        input: {
          name: "Ops",
          useEnv: true,
        },
      }) as CoreConfig;

      expect(updated.channels?.["matrix"]?.accounts?.ops).toMatchObject({
        enabled: true,
        encryption: true,
        name: "Ops",
      });
      expect(updated.channels?.["matrix"]?.accounts?.ops?.homeserver).toBeUndefined();
      expect(updated.channels?.["matrix"]?.accounts?.ops?.userId).toBeUndefined();
      expect(updated.channels?.["matrix"]?.accounts?.ops?.accessToken).toBeUndefined();
      expect(updated.channels?.["matrix"]?.accounts?.ops?.password).toBeUndefined();
      expect(updated.channels?.["matrix"]?.accounts?.ops?.deviceId).toBeUndefined();
      expect(updated.channels?.["matrix"]?.accounts?.ops?.deviceName).toBeUndefined();
      expect(resolveMatrixConfigForAccount(updated, "ops", process.env)).toMatchObject({
        accessToken: "ops-env-token",
        deviceId: "OPSENVDEVICE",
        deviceName: "Ops Env Device",
        homeserver: "https://ops.env.example.org",
      });
    } finally {
      for (const [key, value] of Object.entries(envKeys)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("resolves account id from input name when explicit account id is missing", () => {
    const accountId = matrixPlugin.setup!.resolveAccountId?.({
      accountId: undefined,
      cfg: {} as CoreConfig,
      input: { name: "Main Bot" },
    });
    expect(accountId).toBe("main-bot");
  });

  it("resolves binding account id from agent id when omitted", () => {
    const accountId = matrixPlugin.setup!.resolveBindingAccountId?.({
      accountId: undefined,
      agentId: "Ops",
      cfg: {} as CoreConfig,
    });
    expect(accountId).toBe("ops");
  });

  it("clears stale access token when switching an account to password auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              accessToken: "old-token",
              homeserver: "https://matrix.example.org",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      accountId: "default",
      cfg,
      input: {
        homeserver: "https://matrix.example.org",
        password: "new-password",
        userId: "@bot:example.org", // Pragma: allowlist secret
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix"]?.accounts?.default?.password).toBe("new-password");
    expect(updated.channels?.["matrix"]?.accounts?.default?.accessToken).toBeUndefined();
  });

  it("clears stale password when switching an account to token auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              password: "old-password",
              userId: "@bot:example.org", // Pragma: allowlist secret
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      accountId: "default",
      cfg,
      input: {
        accessToken: "new-token",
        homeserver: "https://matrix.example.org",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix"]?.accounts?.default?.accessToken).toBe("new-token");
    expect(updated.channels?.["matrix"]?.accounts?.default?.password).toBeUndefined();
  });
});
