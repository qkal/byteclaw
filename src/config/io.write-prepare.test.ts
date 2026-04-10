import { describe, expect, it } from "vitest";
import {
  collectChangedPaths,
  formatConfigValidationFailure,
  resolvePersistCandidateForWrite,
  resolveWriteEnvSnapshotForPath,
  restoreEnvRefsFromMap,
  unsetPathForWrite,
} from "./io.write-prepare.js";
import type { OpenClawConfig } from "./types.js";

describe("config io write prepare", () => {
  it("persists caller changes onto resolved config without leaking runtime defaults", () => {
    const persisted = resolvePersistCandidateForWrite({
      nextConfig: {
        gateway: {
          auth: { mode: "token" },
          port: 18_789,
        },
      },
      runtimeConfig: {
        agents: { defaults: { cliBackend: "codex" } },
        gateway: { port: 18_789 },
        messages: { ackReaction: "eyes" },
        sessions: { persistence: true },
      },
      sourceConfig: {
        gateway: { port: 18_789 },
      },
    }) as Record<string, unknown>;

    expect(persisted.gateway).toEqual({
      auth: { mode: "token" },
      port: 18_789,
    });
    expect(persisted).not.toHaveProperty("agents.defaults");
    expect(persisted).not.toHaveProperty("messages.ackReaction");
    expect(persisted).not.toHaveProperty("sessions.persistence");
  });

  it('formats actionable guidance for dmPolicy="open" without wildcard allowFrom', () => {
    const message = formatConfigValidationFailure(
      "channels.telegram.allowFrom",
      'channels.telegram.dmPolicy = "open" requires channels.telegram.allowFrom to include "*"',
    );

    expect(message).toContain("openclaw config set channels.telegram.allowFrom '[\"*\"]'");
    expect(message).toContain('openclaw config set channels.telegram.dmPolicy "pairing"');
  });

  it("unsets explicit paths when runtime defaults would otherwise reappear", () => {
    const next = unsetPathForWrite(
      {
        commands: { ownerDisplay: "hash" },
        gateway: { auth: { mode: "none" } },
      },
      ["commands", "ownerDisplay"],
    );

    expect(next.changed).toBe(true);
    expect(next.next.commands ?? {}).not.toHaveProperty("ownerDisplay");
  });

  it("does not mutate caller config when unsetting existing config objects", () => {
    const input: OpenClawConfig = {
      commands: { ownerDisplay: "hash" },
      gateway: { mode: "local" },
    } satisfies OpenClawConfig;

    const next = unsetPathForWrite(input, ["commands", "ownerDisplay"]);

    expect(input).toEqual({
      commands: { ownerDisplay: "hash" },
      gateway: { mode: "local" },
    });
    expect(next.next.commands ?? {}).not.toHaveProperty("ownerDisplay");
  });

  it("keeps caller arrays immutable when unsetting array entries", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      tools: { alsoAllow: ["exec", "fetch", "read"] },
    } satisfies OpenClawConfig;

    const next = unsetPathForWrite(input, ["tools", "alsoAllow", "1"]);

    expect(input.tools!.alsoAllow).toEqual(["exec", "fetch", "read"]);
    expect((next.next.tools as { alsoAllow?: string[] } | undefined)?.alsoAllow).toEqual([
      "exec",
      "read",
    ]);
  });

  it("treats missing unset paths as no-op without mutating caller config", () => {
    const input: OpenClawConfig = {
      commands: { ownerDisplay: "hash" },
      gateway: { mode: "local" },
    } satisfies OpenClawConfig;

    const next = unsetPathForWrite(input, ["commands", "missingKey"]);

    expect(next.changed).toBe(false);
    expect(next.next).toBe(input);
    expect(input).toEqual({
      commands: { ownerDisplay: "hash" },
      gateway: { mode: "local" },
    });
  });

  it("ignores blocked prototype-key unset path segments", () => {
    const input: OpenClawConfig = {
      commands: { ownerDisplay: "hash" },
      gateway: { mode: "local" },
    } satisfies OpenClawConfig;

    const blocked = [
      ["commands", "__proto__"],
      ["commands", "constructor"],
      ["commands", "prototype"],
    ].map((segments) => unsetPathForWrite(input, segments));

    for (const result of blocked) {
      expect(result.changed).toBe(false);
      expect(result.next).toBe(input);
    }
    expect(input).toEqual({
      commands: { ownerDisplay: "hash" },
      gateway: { mode: "local" },
    });
  });

  it("preserves env refs on unchanged paths while keeping changed paths resolved", () => {
    const changedPaths = new Set<string>();
    collectChangedPaths(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                env: { OPENAI_API_KEY: "sk-secret" },
              },
            },
          },
        },
        gateway: { port: 18_789 },
      },
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                env: { OPENAI_API_KEY: "sk-secret" },
              },
            },
          },
        },
        gateway: {
          auth: { mode: "token" },
          port: 18_789,
        },
      },
      "",
      changedPaths,
    );

    const restored = restoreEnvRefsFromMap(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                env: { OPENAI_API_KEY: "sk-secret" },
              },
            },
          },
        },
        gateway: {
          auth: { mode: "token" },
          port: 18_789,
        },
      },
      "",
      new Map([["agents.defaults.cliBackends.codex.env.OPENAI_API_KEY", "${OPENAI_API_KEY}"]]),
      changedPaths,
    ) as {
      agents: { defaults: { cliBackends: { codex: { env: { OPENAI_API_KEY: string } } } } };
      gateway: { port: number; auth: { mode: string } };
    };

    expect(restored.agents.defaults.cliBackends.codex.env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
    expect(restored.gateway).toEqual({
      auth: { mode: "token" },
      port: 18_789,
    });
  });

  it("preserves env refs in arrays while keeping appended entries resolved", () => {
    const changedPaths = new Set<string>();
    collectChangedPaths(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                args: ["${DISCORD_USER_ID}", "123"],
              },
            },
          },
        },
      },
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                args: ["${DISCORD_USER_ID}", "123", "456"],
              },
            },
          },
        },
      },
      "",
      changedPaths,
    );

    const restored = restoreEnvRefsFromMap(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                args: ["999", "123", "456"],
              },
            },
          },
        },
      },
      "",
      new Map([["agents.defaults.cliBackends.codex.args[0]", "${DISCORD_USER_ID}"]]),
      changedPaths,
    ) as {
      agents: { defaults: { cliBackends: { codex: { args: string[] } } } };
    };

    expect(restored.agents.defaults.cliBackends.codex.args).toEqual([
      "${DISCORD_USER_ID}",
      "123",
      "456",
    ]);
  });

  it("keeps the read-time env snapshot when writing the same config path", () => {
    const snapshot = { OPENAI_API_KEY: "sk-secret" };
    expect(
      resolveWriteEnvSnapshotForPath({
        actualConfigPath: "/tmp/openclaw.json",
        envSnapshotForRestore: snapshot,
        expectedConfigPath: "/tmp/openclaw.json",
      }),
    ).toBe(snapshot);
  });

  it("drops the read-time env snapshot when writing a different config path", () => {
    expect(
      resolveWriteEnvSnapshotForPath({
        actualConfigPath: "/tmp/openclaw.json",
        envSnapshotForRestore: { OPENAI_API_KEY: "sk-secret" },
        expectedConfigPath: "/tmp/other.json",
      }),
    ).toBeUndefined();
  });

  it("keeps plugin AJV defaults out of the persisted candidate", () => {
    const sourceConfig = {
      channels: {
        bluebubbles: {
          password: "test-password",
          serverUrl: "http://localhost:1234",
        },
      },
      gateway: { port: 18_789 },
    } satisfies OpenClawConfig;

    const runtimeConfig: OpenClawConfig = {
      channels: {
        bluebubbles: {
          enrichGroupParticipantsFromContacts: true,
          password: "test-password",
          serverUrl: "http://localhost:1234",
        },
      },
      gateway: { port: 18_789 },
    } satisfies OpenClawConfig;

    const nextConfig: OpenClawConfig = structuredClone(runtimeConfig);
    nextConfig.gateway = {
      ...nextConfig.gateway,
      auth: { mode: "token" },
    };

    const persisted = resolvePersistCandidateForWrite({
      nextConfig,
      runtimeConfig,
      sourceConfig,
    }) as Record<string, unknown>;

    expect(persisted.gateway).toEqual({
      auth: { mode: "token" },
      port: 18_789,
    });
    const channels = persisted.channels as Record<string, Record<string, unknown>> | undefined;
    expect(channels?.bluebubbles).toBeDefined();
    expect(channels?.bluebubbles).not.toHaveProperty("enrichGroupParticipantsFromContacts");
    expect(channels?.bluebubbles?.serverUrl).toBe("http://localhost:1234");
    expect(channels?.bluebubbles?.password).toBe("test-password");
  });

  it("does not reintroduce legacy nested dm.policy defaults in the persisted candidate", () => {
    const sourceConfig: OpenClawConfig = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "pairing" },
          dmPolicy: "pairing",
        },
        slack: {
          dm: { enabled: true, policy: "pairing" },
          dmPolicy: "pairing",
        },
      },
      gateway: { port: 18_789 },
    } satisfies OpenClawConfig;

    const nextConfig = structuredClone(sourceConfig);
    delete (nextConfig.channels?.discord?.dm as { enabled?: boolean; policy?: string } | undefined)
      ?.policy;
    delete (nextConfig.channels?.slack?.dm as { enabled?: boolean; policy?: string } | undefined)
      ?.policy;

    const persisted = resolvePersistCandidateForWrite({
      nextConfig,
      runtimeConfig: sourceConfig,
      sourceConfig,
    }) as {
      channels?: {
        discord?: { dm?: Record<string, unknown>; dmPolicy?: unknown };
        slack?: { dm?: Record<string, unknown>; dmPolicy?: unknown };
      };
    };

    expect(persisted.channels?.discord?.dmPolicy).toBe("pairing");
    expect(persisted.channels?.discord?.dm).toEqual({ enabled: true });
    expect(persisted.channels?.slack?.dmPolicy).toBe("pairing");
    expect(persisted.channels?.slack?.dm).toEqual({ enabled: true });
  });

  it("preserves normalized nested channel enabled keys during unrelated writes", () => {
    const sourceConfig = {
      channels: {
        discord: {
          guilds: {
            "100": {
              channels: {
                general: {
                  enabled: false,
                },
              },
            },
          },
        },
        googlechat: {
          groups: {
            "spaces/aaa": {
              enabled: true,
            },
          },
        },
        slack: {
          channels: {
            ops: {
              enabled: false,
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const nextConfig: OpenClawConfig = {
      ...structuredClone(sourceConfig),
      gateway: {
        auth: { mode: "token" },
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      nextConfig,
      runtimeConfig: sourceConfig,
      sourceConfig,
    }) as {
      channels?: {
        slack?: { channels?: Record<string, Record<string, unknown>> };
        googlechat?: { groups?: Record<string, Record<string, unknown>> };
        discord?: {
          guilds?: Record<string, { channels?: Record<string, Record<string, unknown>> }>;
        };
      };
      gateway?: Record<string, unknown>;
    };

    expect(persisted.gateway).toEqual({
      auth: { mode: "token" },
    });
    expect(persisted.channels?.slack?.channels?.ops).toEqual({ enabled: false });
    expect(persisted.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({ enabled: true });
    expect(persisted.channels?.discord?.guilds?.["100"]?.channels?.general).toEqual({
      enabled: false,
    });
  });
});
