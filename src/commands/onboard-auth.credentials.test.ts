import { afterEach, describe, expect, it } from "vitest";
import { upsertApiKeyProfile } from "../plugins/provider-auth-helpers.js";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

describe("onboard auth credentials secret refs", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "MOONSHOT_API_KEY",
    "OPENAI_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "VOLCANO_ENGINE_API_KEY",
    "BYTEPLUS_API_KEY",
    "OPENCODE_API_KEY",
  ]);

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  interface AuthProfileEntry {
    key?: string;
    keyRef?: unknown;
    metadata?: unknown;
  }

  async function withAuthEnv(
    prefix: string,
    run: (env: Awaited<ReturnType<typeof setupAuthTestEnv>>) => Promise<void>,
  ) {
    const env = await setupAuthTestEnv(prefix);
    lifecycle.setStateDir(env.stateDir);
    await run(env);
  }

  async function readProfile(
    agentDir: string,
    profileId: string,
  ): Promise<AuthProfileEntry | undefined> {
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, AuthProfileEntry>;
    }>(agentDir);
    return parsed.profiles?.[profileId];
  }

  async function expectStoredAuthKey(params: {
    prefix: string;
    envVar?: string;
    envValue?: string;
    profileId: string;
    apply: (agentDir: string) => Promise<void>;
    expected: AuthProfileEntry;
    absent?: (keyof AuthProfileEntry)[];
  }) {
    await withAuthEnv(params.prefix, async (env) => {
      if (params.envVar && params.envValue !== undefined) {
        process.env[params.envVar] = params.envValue;
      }
      await params.apply(env.agentDir);
      const profile = await readProfile(env.agentDir, params.profileId);
      expect(profile).toMatchObject(params.expected);
      for (const key of params.absent ?? []) {
        expect(profile?.[key]).toBeUndefined();
      }
    });
  }

  it("keeps env-backed moonshot key as plaintext by default", async () => {
    await expectStoredAuthKey({
      absent: ["keyRef"],
      apply: async () => {
        upsertApiKeyProfile({ input: "sk-moonshot-env", provider: "moonshot" });
      },
      envValue: "sk-moonshot-env",
      envVar: "MOONSHOT_API_KEY",
      expected: {
        key: "sk-moonshot-env",
      },
      prefix: "openclaw-onboard-auth-credentials-",
      profileId: "moonshot:default",
    });
  });

  it("stores env-backed moonshot key as keyRef when secret-input-mode=ref", async () => {
    await expectStoredAuthKey({
      absent: ["key"],
      apply: async (agentDir) => {
        upsertApiKeyProfile({
          agentDir,
          input: "sk-moonshot-env",
          options: { secretInputMode: "ref" },
          provider: "moonshot", // Pragma: allowlist secret
        });
      },
      envValue: "sk-moonshot-env",
      envVar: "MOONSHOT_API_KEY",
      expected: {
        keyRef: { id: "MOONSHOT_API_KEY", provider: "default", source: "env" },
      },
      prefix: "openclaw-onboard-auth-credentials-ref-",
      profileId: "moonshot:default",
    });
  });

  it("stores ${ENV} moonshot input as keyRef even when env value is unset", async () => {
    await expectStoredAuthKey({
      absent: ["key"],
      apply: async () => {
        upsertApiKeyProfile({ input: "${MOONSHOT_API_KEY}", provider: "moonshot" });
      },
      expected: {
        keyRef: { id: "MOONSHOT_API_KEY", provider: "default", source: "env" },
      },
      prefix: "openclaw-onboard-auth-credentials-inline-ref-",
      profileId: "moonshot:default",
    });
  });

  it("keeps plaintext moonshot key when no env ref applies", async () => {
    await expectStoredAuthKey({
      absent: ["keyRef"],
      apply: async () => {
        upsertApiKeyProfile({ input: "sk-moonshot-plaintext", provider: "moonshot" });
      },
      envValue: "sk-moonshot-other",
      envVar: "MOONSHOT_API_KEY",
      expected: {
        key: "sk-moonshot-plaintext",
      },
      prefix: "openclaw-onboard-auth-credentials-plaintext-",
      profileId: "moonshot:default",
    });
  });

  it("preserves cloudflare metadata when storing keyRef", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-cloudflare-");
    lifecycle.setStateDir(env.stateDir);
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "cf-secret"; // Pragma: allowlist secret

    upsertApiKeyProfile({
      provider: "cloudflare-ai-gateway",
      input: "cf-secret",
      agentDir: env.agentDir,
      options: { secretInputMode: "ref" }, // Pragma: allowlist secret
      metadata: {
        accountId: "account-1",
        gatewayId: "gateway-1",
      },
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown; metadata?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
      keyRef: { id: "CLOUDFLARE_AI_GATEWAY_API_KEY", provider: "default", source: "env" },
      metadata: { accountId: "account-1", gatewayId: "gateway-1" },
    });
    expect(parsed.profiles?.["cloudflare-ai-gateway:default"]?.key).toBeUndefined();
  });

  it("keeps env-backed openai key as plaintext by default", async () => {
    await expectStoredAuthKey({
      absent: ["keyRef"],
      apply: async () => {
        upsertApiKeyProfile({ input: "sk-openai-env", provider: "openai" });
      },
      envValue: "sk-openai-env",
      envVar: "OPENAI_API_KEY",
      expected: {
        key: "sk-openai-env",
      },
      prefix: "openclaw-onboard-auth-credentials-openai-",
      profileId: "openai:default",
    });
  });

  it("stores env-backed openai key as keyRef in ref mode", async () => {
    await expectStoredAuthKey({
      absent: ["key"],
      apply: async (agentDir) => {
        upsertApiKeyProfile({
          agentDir,
          input: "sk-openai-env",
          options: { secretInputMode: "ref" },
          provider: "openai", // Pragma: allowlist secret
        });
      },
      envValue: "sk-openai-env",
      envVar: "OPENAI_API_KEY",
      expected: {
        keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
      },
      prefix: "openclaw-onboard-auth-credentials-openai-ref-",
      profileId: "openai:default",
    });
  });

  it("stores env-backed volcengine and byteplus keys as keyRef in ref mode", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-volc-byte-");
    lifecycle.setStateDir(env.stateDir);
    process.env.VOLCANO_ENGINE_API_KEY = "volcengine-secret"; // Pragma: allowlist secret
    process.env.BYTEPLUS_API_KEY = "byteplus-secret"; // Pragma: allowlist secret

    upsertApiKeyProfile({
      agentDir: env.agentDir,
      input: "volcengine-secret",
      options: { secretInputMode: "ref" },
      provider: "volcengine", // Pragma: allowlist secret
    });
    upsertApiKeyProfile({
      agentDir: env.agentDir,
      input: "byteplus-secret",
      options: { secretInputMode: "ref" },
      provider: "byteplus", // Pragma: allowlist secret
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);

    expect(parsed.profiles?.["volcengine:default"]).toMatchObject({
      keyRef: { id: "VOLCANO_ENGINE_API_KEY", provider: "default", source: "env" },
    });
    expect(parsed.profiles?.["volcengine:default"]?.key).toBeUndefined();

    expect(parsed.profiles?.["byteplus:default"]).toMatchObject({
      keyRef: { id: "BYTEPLUS_API_KEY", provider: "default", source: "env" },
    });
    expect(parsed.profiles?.["byteplus:default"]?.key).toBeUndefined();
  });

  it("stores shared OpenCode credentials for both runtime providers", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-opencode-");
    lifecycle.setStateDir(env.stateDir);
    process.env.OPENCODE_API_KEY = "sk-opencode-env"; // Pragma: allowlist secret

    for (const provider of ["opencode", "opencode-go"] as const) {
      upsertApiKeyProfile({
        agentDir: env.agentDir,
        input: "sk-opencode-env",
        options: { secretInputMode: "ref" },
        provider, // Pragma: allowlist secret
      });
    }

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);

    expect(parsed.profiles?.["opencode:default"]).toMatchObject({
      keyRef: { id: "OPENCODE_API_KEY", provider: "default", source: "env" },
    });
    expect(parsed.profiles?.["opencode-go:default"]).toMatchObject({
      keyRef: { id: "OPENCODE_API_KEY", provider: "default", source: "env" },
    });
  });
});
