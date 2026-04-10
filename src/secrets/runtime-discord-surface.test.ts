import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const discordSecrets = loadBundledChannelSecretContractApi("discord");
if (!discordSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Discord secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "discord"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: discordSecrets.collectRuntimeConfigAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "discord"
      ? {
          collectRuntimeConfigAssignments: discordSecrets.collectRuntimeConfigAssignments,
        }
      : undefined,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    profiles,
    version: 1,
  };
}

describe("secrets runtime snapshot discord surface", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("fails when non-default Discord account inherits an unresolved top-level token ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          channels: {
            discord: {
              accounts: {
                work: {
                  enabled: true,
                },
              },
              token: {
                id: "MISSING_DISCORD_BASE_TOKEN",
                provider: "default",
                source: "env",
              },
            },
          },
        }),
        env: {},
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow('Environment variable "MISSING_DISCORD_BASE_TOKEN" is missing or empty.');
  });

  it("treats top-level Discord token refs as inactive when account token is explicitly blank", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          discord: {
            accounts: {
              default: {
                enabled: true,
                token: "",
              },
            },
            token: {
              id: "MISSING_DISCORD_DEFAULT_TOKEN",
              provider: "default",
              source: "env",
            },
          },
        },
      }),
      env: {},
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.token).toEqual({
      id: "MISSING_DISCORD_DEFAULT_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("channels.discord.token");
  });

  it("treats Discord PluralKit token refs as inactive when PluralKit is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          discord: {
            pluralkit: {
              enabled: false,
              token: {
                id: "MISSING_DISCORD_PLURALKIT_TOKEN",
                provider: "default",
                source: "env",
              },
            },
          },
        },
      }),
      env: {},
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.pluralkit?.token).toEqual({
      id: "MISSING_DISCORD_PLURALKIT_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.pluralkit.token",
    );
  });

  it("treats Discord voice TTS refs as inactive when voice is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          discord: {
            accounts: {
              work: {
                enabled: true,
                voice: {
                  enabled: false,
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          id: "MISSING_DISCORD_WORK_VOICE_TTS_OPENAI",
                          provider: "default",
                          source: "env",
                        },
                      },
                    },
                  },
                },
              },
            },
            voice: {
              enabled: false,
              tts: {
                providers: {
                  openai: {
                    apiKey: {
                      id: "MISSING_DISCORD_VOICE_TTS_OPENAI",
                      provider: "default",
                      source: "env",
                    },
                  },
                },
              },
            },
          },
        },
      }),
      env: {},
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual({
      id: "MISSING_DISCORD_VOICE_TTS_OPENAI",
      provider: "default",
      source: "env",
    });
    expect(
      snapshot.config.channels?.discord?.accounts?.work?.voice?.tts?.providers?.openai?.apiKey,
    ).toEqual({
      id: "MISSING_DISCORD_WORK_VOICE_TTS_OPENAI",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.discord.voice.tts.providers.openai.apiKey",
        "channels.discord.accounts.work.voice.tts.providers.openai.apiKey",
      ]),
    );
  });

  it("handles Discord nested inheritance for enabled and disabled accounts", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          discord: {
            accounts: {
              disabledOverride: {
                enabled: false,
                pluralkit: {
                  token: {
                    id: "DISCORD_DISABLED_OVERRIDE_PK_TOKEN",
                    provider: "default",
                    source: "env",
                  },
                },
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          id: "DISCORD_DISABLED_OVERRIDE_TTS_OPENAI",
                          provider: "default",
                          source: "env",
                        },
                      },
                    },
                  },
                },
              },
              enabledInherited: {
                enabled: true,
              },
              enabledOverride: {
                enabled: true,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          id: "DISCORD_ENABLED_OVERRIDE_TTS_OPENAI",
                          provider: "default",
                          source: "env",
                        },
                      },
                    },
                  },
                },
              },
            },
            pluralkit: {
              token: { id: "DISCORD_BASE_PK_TOKEN", provider: "default", source: "env" },
            },
            voice: {
              tts: {
                providers: {
                  openai: {
                    apiKey: { id: "DISCORD_BASE_TTS_OPENAI", provider: "default", source: "env" },
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        DISCORD_BASE_PK_TOKEN: "base-pk-token",
        DISCORD_BASE_TTS_OPENAI: "base-tts-openai",
        DISCORD_ENABLED_OVERRIDE_TTS_OPENAI: "enabled-override-tts-openai",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toBe(
      "base-tts-openai",
    );
    expect(snapshot.config.channels?.discord?.pluralkit?.token).toBe("base-pk-token");
    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-override-tts-openai");
    expect(
      snapshot.config.channels?.discord?.accounts?.disabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toEqual({
      id: "DISCORD_DISABLED_OVERRIDE_TTS_OPENAI",
      provider: "default",
      source: "env",
    });
    expect(snapshot.config.channels?.discord?.accounts?.disabledOverride?.pluralkit?.token).toEqual(
      {
        id: "DISCORD_DISABLED_OVERRIDE_PK_TOKEN",
        provider: "default",
        source: "env",
      },
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.discord.accounts.disabledOverride.voice.tts.providers.openai.apiKey",
        "channels.discord.accounts.disabledOverride.pluralkit.token",
      ]),
    );
  });

  it("skips top-level Discord voice refs when all enabled accounts override nested voice config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          discord: {
            accounts: {
              disabledInherited: {
                enabled: false,
              },
              enabledOverride: {
                enabled: true,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          id: "DISCORD_ENABLED_ONLY_TTS_OPENAI",
                          provider: "default",
                          source: "env",
                        },
                      },
                    },
                  },
                },
              },
            },
            voice: {
              tts: {
                providers: {
                  openai: {
                    apiKey: {
                      id: "DISCORD_UNUSED_BASE_TTS_OPENAI",
                      provider: "default",
                      source: "env",
                    },
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        DISCORD_ENABLED_ONLY_TTS_OPENAI: "enabled-only-tts-openai",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-only-tts-openai");
    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual({
      id: "DISCORD_UNUSED_BASE_TTS_OPENAI",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.voice.tts.providers.openai.apiKey",
    );
  });

  it("fails when an enabled Discord account override has an unresolved nested ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          channels: {
            discord: {
              accounts: {
                enabledOverride: {
                  enabled: true,
                  voice: {
                    tts: {
                      providers: {
                        openai: {
                          apiKey: {
                            id: "DISCORD_ENABLED_OVERRIDE_TTS_MISSING",
                            provider: "default",
                            source: "env",
                          },
                        },
                      },
                    },
                  },
                },
              },
              voice: {
                tts: {
                  providers: {
                    openai: {
                      apiKey: { id: "DISCORD_BASE_TTS_OK", provider: "default", source: "env" },
                    },
                  },
                },
              },
            },
          },
        }),
        env: {
          DISCORD_BASE_TTS_OK: "base-tts-openai",
        },
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow(
      'Environment variable "DISCORD_ENABLED_OVERRIDE_TTS_MISSING" is missing or empty.',
    );
  });
});
