import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("secrets runtime snapshot", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("resolves sandbox ssh secret refs for active ssh backends", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              backend: "ssh",
              mode: "all",
              ssh: {
                certificateData: {
                  id: "SSH_CERTIFICATE_DATA",
                  provider: "default",
                  source: "env",
                },
                identityData: { id: "SSH_IDENTITY_DATA", provider: "default", source: "env" },
                knownHostsData: {
                  id: "SSH_KNOWN_HOSTS_DATA",
                  provider: "default",
                  source: "env",
                },
                target: "peter@example.com:22",
              },
            },
          },
        },
      }),
      env: {
        SSH_CERTIFICATE_DATA: "SSH CERT",
        SSH_IDENTITY_DATA: "PRIVATE KEY",
        SSH_KNOWN_HOSTS_DATA: "example.com ssh-ed25519 AAAATEST",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh).toMatchObject({
      certificateData: "SSH CERT",
      identityData: "PRIVATE KEY",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
  });

  it("treats sandbox ssh secret refs as inactive when ssh backend is not selected", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              backend: "docker",
              mode: "all",
              ssh: {
                identityData: { id: "SSH_IDENTITY_DATA", provider: "default", source: "env" },
              },
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual({
      id: "SSH_IDENTITY_DATA",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "agents.defaults.sandbox.ssh.identityData",
        }),
      ]),
    );
  });

  it("fails when an active exec ref id contains traversal segments", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          secrets: {
            providers: {
              vault: {
                command: process.execPath,
                source: "exec",
              },
            },
          },
          talk: {
            apiKey: { id: "a/../b", provider: "vault", source: "exec" },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        loadAuthStore: () => ({ profiles: {}, version: 1 }),
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow(/must not include "\." or "\.\." path segments/i);
  });
});
