import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
  buildTalkTestProviderConfig,
} from "../test-utils/talk-test-provider.js";
import type { SecretsApplyPlan } from "./plan.js";

let runSecretsApply: typeof import("./apply.js").runSecretsApply;
let applyTesting: typeof import("./apply.js").__testing;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;

const OPENAI_API_KEY_ENV_REF = {
  id: "OPENAI_API_KEY",
  provider: "default",
  source: "env",
} as const;

interface ApplyFixture {
  rootDir: string;
  stateDir: string;
  configPath: string;
  authStorePath: string;
  authJsonPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
}

function stripVolatileConfigMeta(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as Record<string, unknown>;
  const meta =
    parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
      ? { ...(parsed.meta as Record<string, unknown>) }
      : undefined;
  if (meta && "lastTouchedAt" in meta) {
    delete meta.lastTouchedAt;
  }
  if (meta) {
    parsed.meta = meta;
  }
  return parsed;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createOpenAiProviderConfig(apiKey: unknown = "sk-openai-plaintext") {
  return {
    api: "openai-completions",
    apiKey,
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "gpt-5", name: "gpt-5" }],
  };
}

function buildFixturePaths(rootDir: string) {
  const stateDir = path.join(rootDir, ".openclaw");
  return {
    authJsonPath: path.join(stateDir, "agents", "main", "agent", "auth.json"),
    authStorePath: path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
    configPath: path.join(stateDir, "openclaw.json"),
    envPath: path.join(stateDir, ".env"),
    rootDir,
    stateDir,
  };
}

async function createApplyFixture(): Promise<ApplyFixture> {
  const paths = buildFixturePaths(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-apply-")),
  );
  await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.authStorePath), { recursive: true });
  return {
    ...paths,
    env: {
      OPENAI_API_KEY: "sk-live-env",
      OPENCLAW_CONFIG_PATH: paths.configPath,
      OPENCLAW_STATE_DIR: paths.stateDir, // Pragma: allowlist secret
    },
  };
}

async function seedDefaultApplyFixture(fixture: ApplyFixture): Promise<void> {
  await writeJsonFile(fixture.configPath, {
    models: {
      providers: {
        openai: createOpenAiProviderConfig(),
      },
    },
  });
  await writeJsonFile(fixture.authStorePath, {
    profiles: {
      "openai:default": {
        key: "sk-openai-plaintext",
        provider: "openai",
        type: "api_key", // Pragma: allowlist secret
      },
    },
    version: 1,
  });
  await writeJsonFile(fixture.authJsonPath, {
    openai: {
      key: "sk-openai-plaintext",
      type: "api_key", // Pragma: allowlist secret
    },
  });
  await fs.writeFile(
    fixture.envPath,
    "OPENAI_API_KEY=sk-openai-plaintext\nUNRELATED=value\n", // Pragma: allowlist secret
    "utf8",
  );
}

async function applyPlanAndReadConfig<T>(
  fixture: ApplyFixture,
  plan: SecretsApplyPlan,
): Promise<T> {
  const result = await runSecretsApply({ env: fixture.env, plan, write: true });
  expect(result.changed).toBe(true);
  return JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as T;
}

function createPlan(params: {
  targets: SecretsApplyPlan["targets"];
  options?: SecretsApplyPlan["options"];
  providerUpserts?: SecretsApplyPlan["providerUpserts"];
  providerDeletes?: SecretsApplyPlan["providerDeletes"];
}): SecretsApplyPlan {
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: "manual",
    protocolVersion: 1,
    targets: params.targets,
    version: 1,
    ...(params.options ? { options: params.options } : {}),
    ...(params.providerUpserts ? { providerUpserts: params.providerUpserts } : {}),
    ...(params.providerDeletes ? { providerDeletes: params.providerDeletes } : {}),
  };
}

function createOpenAiProviderTarget(params?: {
  path?: string;
  pathSegments?: string[];
  providerId?: string;
}): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.apiKey",
    path: params?.path ?? "models.providers.openai.apiKey",
    ...(params?.pathSegments ? { pathSegments: params.pathSegments } : {}),
    providerId: params?.providerId ?? "openai",
    ref: OPENAI_API_KEY_ENV_REF,
  };
}

function createOpenAiProviderHeaderTarget(params?: {
  path?: string;
  pathSegments?: string[];
}): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.headers",
    path: params?.path ?? "models.providers.openai.headers.x-api-key",
    ...(params?.pathSegments ? { pathSegments: params.pathSegments } : {}),
    ref: OPENAI_API_KEY_ENV_REF,
  };
}

function createOneWayScrubOptions(): NonNullable<SecretsApplyPlan["options"]> {
  return {
    scrubAuthProfilesForProviderTargets: true,
    scrubEnv: true,
    scrubLegacyAuthJson: true,
  };
}

describe("secrets apply", () => {
  let fixture: ApplyFixture;

  beforeAll(async () => {
    ({ __testing: applyTesting, runSecretsApply } = await import("./apply.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  beforeEach(async () => {
    clearSecretsRuntimeSnapshot();
    fixture = await createApplyFixture();
    await seedDefaultApplyFixture(fixture);
  });

  afterEach(async () => {
    clearSecretsRuntimeSnapshot();
    await fs.rm(fixture.rootDir, { force: true, recursive: true });
  });

  it("preflights and applies one-way scrub without plaintext backups", async () => {
    const plan = createPlan({
      options: createOneWayScrubOptions(),
      targets: [createOpenAiProviderTarget()],
    });

    const dryRun = await runSecretsApply({ env: fixture.env, plan, write: false });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.changed).toBe(true);
    expect(dryRun.skippedExecRefs).toBe(0);
    expect(dryRun.checks.resolvabilityComplete).toBe(true);

    const applied = await runSecretsApply({ env: fixture.env, plan, write: true });
    expect(applied.mode).toBe("write");
    expect(applied.changed).toBe(true);

    const nextConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as {
      models: { providers: { openai: { apiKey: unknown } } };
    };
    expect(nextConfig.models.providers.openai.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);

    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:default"].key).toBeUndefined();
    expect(nextAuthStore.profiles["openai:default"].keyRef).toBeUndefined();

    const nextAuthJson = JSON.parse(await fs.readFile(fixture.authJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(nextAuthJson.openai).toBeUndefined();

    const nextEnv = await fs.readFile(fixture.envPath, "utf8");
    expect(nextEnv).not.toContain("sk-openai-plaintext");
    expect(nextEnv).toContain("UNRELATED=value");
  });

  it("skips exec SecretRef checks during dry-run unless explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await fs.writeFile(
      execScriptPath,
      [
        "#!/bin/sh",
        `printf 'x\\n' >> ${JSON.stringify(execLogPath)}`,
        "cat >/dev/null",
        'printf \'{"protocolVersion":1,"values":{"providers/openai/apiKey":"sk-openai-exec"}}\'', // Pragma: allowlist secret
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );

    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: createOpenAiProviderConfig(),
        },
      },
      secrets: {
        providers: {
          execmain: {
            command: execScriptPath,
            jsonOnly: true,
            noOutputTimeoutMs: 10_000,
            source: "exec",
            timeoutMs: 20_000,
          },
        },
      },
    });

    const plan = createPlan({
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      targets: [
        {
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { id: "providers/openai/apiKey", provider: "execmain", source: "exec" },
          type: "models.providers.apiKey",
        },
      ],
    });

    const dryRunSkipped = await runSecretsApply({ env: fixture.env, plan, write: false });
    expect(dryRunSkipped.mode).toBe("dry-run");
    expect(dryRunSkipped.skippedExecRefs).toBe(1);
    expect(dryRunSkipped.checks.resolvabilityComplete).toBe(false);
    await expect(fs.stat(execLogPath)).rejects.toMatchObject({ code: "ENOENT" });

    const dryRunAllowed = await runSecretsApply({
      allowExec: true,
      env: fixture.env,
      plan,
      write: false,
    });
    expect(dryRunAllowed.mode).toBe("dry-run");
    expect(dryRunAllowed.skippedExecRefs).toBe(0);
    const callLog = await fs.readFile(execLogPath, "utf8");
    expect(callLog.split("\n").filter((line) => line.trim().length > 0).length).toBeGreaterThan(0);
  });

  it("ignores unrelated auth-profile store refs during allowExec dry-run preflight", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await fs.writeFile(
      execScriptPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        'printf \'{"protocolVersion":1,"values":{"providers/openai/apiKey":"sk-openai-exec"}}\'', // Pragma: allowlist secret
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );

    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: createOpenAiProviderConfig(),
        },
      },
      secrets: {
        providers: {
          execmain: {
            command: execScriptPath,
            jsonOnly: true,
            noOutputTimeoutMs: 10_000,
            source: "exec",
            timeoutMs: 20_000,
          },
        },
      },
    });
    await writeJsonFile(fixture.authStorePath, {
      profiles: {
        "openai:default": {
          keyRef: { id: "MISSING_AUTH_STORE_KEY", provider: "default", source: "env" },
          provider: "openai",
          type: "api_key",
        },
      },
      version: 1,
    });

    const plan = createPlan({
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      targets: [
        {
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { id: "providers/openai/apiKey", provider: "execmain", source: "exec" },
          type: "models.providers.apiKey",
        },
      ],
    });

    await expect(
      runSecretsApply({ allowExec: true, env: fixture.env, plan, write: false }),
    ).resolves.toMatchObject({
      checks: { resolvabilityComplete: true },
      mode: "dry-run",
      skippedExecRefs: 0,
    });
  });

  it("ignores unrelated auth-profile store refs during no-op write apply", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            ...createOpenAiProviderConfig(),
            apiKey: OPENAI_API_KEY_ENV_REF,
          },
        },
      },
    });
    await writeJsonFile(fixture.authStorePath, {
      profiles: {
        "openai:default": {
          keyRef: { id: "MISSING_AUTH_STORE_KEY", provider: "default", source: "env" },
          provider: "openai",
          type: "api_key",
        },
      },
      version: 1,
    });

    const plan = createPlan({
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      targets: [createOpenAiProviderTarget()],
    });

    await expect(runSecretsApply({ env: fixture.env, plan, write: true })).resolves.toMatchObject({
      changed: false,
      changedFiles: [],
      checks: { resolvabilityComplete: true },
      mode: "write",
    });
  });

  it("rejects write mode for exec plans unless allowExec is set", async () => {
    const plan = createPlan({
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      targets: [
        {
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { id: "providers/openai/apiKey", provider: "execmain", source: "exec" },
          type: "models.providers.apiKey",
        },
      ],
    });

    await expect(runSecretsApply({ env: fixture.env, plan, write: true })).rejects.toThrow(
      "Plan contains exec SecretRefs/providers. Re-run with --allow-exec.",
    );
  });

  it("rejects write mode for plans with exec provider upserts unless allowExec is set", async () => {
    const plan = createPlan({
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      providerUpserts: {
        execmain: {
          args: ["ok"],
          command: "/bin/echo",
          source: "exec",
        },
      },
      targets: [createOpenAiProviderTarget()],
    });

    await expect(runSecretsApply({ env: fixture.env, plan, write: true })).rejects.toThrow(
      "Plan contains exec SecretRefs/providers. Re-run with --allow-exec.",
    );
  });

  it("applies auth-profiles sibling ref targets to the scoped agent store", async () => {
    const plan: SecretsApplyPlan = {
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      protocolVersion: 1,
      targets: [
        {
          agentId: "main",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          ref: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          type: "auth-profiles.api_key.key",
        },
      ],
      version: 1,
    };

    const result = await runSecretsApply({ env: fixture.env, plan, write: true });
    expect(result.changed).toBe(true);
    expect(result.changedFiles).toContain(fixture.authStorePath);

    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:default"].key).toBeUndefined();
    expect(nextAuthStore.profiles["openai:default"].keyRef).toEqual({
      id: "OPENAI_API_KEY",
      provider: "default",
      source: "env",
    });
  });

  it("creates a new auth-profiles mapping when provider metadata is supplied", async () => {
    const plan: SecretsApplyPlan = {
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      protocolVersion: 1,
      targets: [
        {
          agentId: "main",
          authProfileProvider: "openai",
          path: "profiles.openai:bot.token",
          pathSegments: ["profiles", "openai:bot", "token"],
          ref: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          type: "auth-profiles.token.token",
        },
      ],
      version: 1,
    };

    await runSecretsApply({ env: fixture.env, plan, write: true });
    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: {
        "openai:bot": {
          type: string;
          provider: string;
          tokenRef?: unknown;
        };
      };
    };
    expect(nextAuthStore.profiles["openai:bot"]).toEqual({
      provider: "openai",
      tokenRef: {
        id: "OPENAI_API_KEY",
        provider: "default",
        source: "env",
      },
      type: "token",
    });
  });

  it("is idempotent on repeated write applies", async () => {
    const plan = createPlan({
      options: createOneWayScrubOptions(),
      targets: [createOpenAiProviderTarget()],
    });

    const first = await runSecretsApply({ env: fixture.env, plan, write: true });
    expect(first.changed).toBe(true);
    const configAfterFirst = await fs.readFile(fixture.configPath, "utf8");
    const authStoreAfterFirst = await fs.readFile(fixture.authStorePath, "utf8");
    const authJsonAfterFirst = await fs.readFile(fixture.authJsonPath, "utf8");
    const envAfterFirst = await fs.readFile(fixture.envPath, "utf8");

    await fs.chmod(fixture.configPath, 0o400);
    await fs.chmod(fixture.authStorePath, 0o400);

    const second = await runSecretsApply({ env: fixture.env, plan, write: true });
    expect(second.mode).toBe("write");
    const configAfterSecond = await fs.readFile(fixture.configPath, "utf8");
    expect(stripVolatileConfigMeta(configAfterSecond)).toEqual(
      stripVolatileConfigMeta(configAfterFirst),
    );
    await expect(fs.readFile(fixture.authStorePath, "utf8")).resolves.toBe(authStoreAfterFirst);
    await expect(fs.readFile(fixture.authJsonPath, "utf8")).resolves.toBe(authJsonAfterFirst);
    await expect(fs.readFile(fixture.envPath, "utf8")).resolves.toBe(envAfterFirst);
  });

  it("applies targets safely when map keys contain dots", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          "openai.dev": createOpenAiProviderConfig(),
        },
      },
    });

    const plan = createPlan({
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      targets: [
        createOpenAiProviderTarget({
          path: "models.providers.openai.dev.apiKey",
          pathSegments: ["models", "providers", "openai.dev", "apiKey"],
          providerId: "openai.dev",
        }),
      ],
    });

    const nextConfig = (await applyTesting.projectConfigForTest({
      env: fixture.env,
      plan,
    })) as {
      models?: {
        providers?: Record<string, { apiKey?: unknown }>;
      };
    };
    expect(nextConfig.models?.providers?.["openai.dev"]?.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);
    expect(nextConfig.models?.providers?.openai).toBeUndefined();
  });

  it("migrates skills entries apiKey targets alongside provider api keys", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: createOpenAiProviderConfig(),
        },
      },
      skills: {
        entries: {
          "qa-secret-test": {
            apiKey: "sk-skill-plaintext",
            enabled: true, // Pragma: allowlist secret
          },
        },
      },
    });

    const plan = createPlan({
      options: createOneWayScrubOptions(),
      targets: [
        createOpenAiProviderTarget({ pathSegments: ["models", "providers", "openai", "apiKey"] }),
        {
          path: "skills.entries.qa-secret-test.apiKey",
          pathSegments: ["skills", "entries", "qa-secret-test", "apiKey"],
          ref: OPENAI_API_KEY_ENV_REF,
          type: "skills.entries.apiKey",
        },
      ],
    });

    const nextConfig = await applyPlanAndReadConfig<{
      models: { providers: { openai: { apiKey: unknown } } };
      skills: { entries: { "qa-secret-test": { apiKey: unknown } } };
    }>(fixture, plan);
    expect(nextConfig.models.providers.openai.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);
    expect(nextConfig.skills.entries["qa-secret-test"].apiKey).toEqual(OPENAI_API_KEY_ENV_REF);

    const rawConfig = await fs.readFile(fixture.configPath, "utf8");
    expect(rawConfig).not.toContain("sk-openai-plaintext");
    expect(rawConfig).not.toContain("sk-skill-plaintext");
  });

  it("applies talk provider target types", async () => {
    await writeJsonFile(
      fixture.configPath,
      buildTalkTestProviderConfig("sk-talk-plaintext"), // Pragma: allowlist secret
    );

    const plan: SecretsApplyPlan = {
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      protocolVersion: 1,
      targets: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          ref: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          type: "talk.providers.*.apiKey",
        },
      ],
      version: 1,
    };

    const nextConfig = (await applyTesting.projectConfigForTest({
      env: fixture.env,
      plan,
    })) as {
      talk?: { providers?: Record<string, { apiKey?: unknown }> };
    };
    expect(nextConfig.talk?.providers?.[TALK_TEST_PROVIDER_ID]?.apiKey).toEqual({
      id: "OPENAI_API_KEY",
      provider: "default",
      source: "env",
    });
  });

  it("applies model provider header targets", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            ...createOpenAiProviderConfig(),
            headers: {
              "x-api-key": "sk-header-plaintext",
            },
          },
        },
      },
    });

    const plan = createPlan({
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      targets: [
        createOpenAiProviderHeaderTarget({
          pathSegments: ["models", "providers", "openai", "headers", "x-api-key"],
        }),
      ],
    });

    const nextConfig = (await applyTesting.projectConfigForTest({
      env: fixture.env,
      plan,
    })) as {
      models?: {
        providers?: {
          openai?: {
            headers?: Record<string, unknown>;
          };
        };
      };
    };
    expect(nextConfig.models?.providers?.openai?.headers?.["x-api-key"]).toEqual(
      OPENAI_API_KEY_ENV_REF,
    );
  });

  it("applies array-indexed targets for agent memory search", async () => {
    await fs.writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          agents: {
            list: [
              {
                id: "main",
                memorySearch: {
                  remote: {
                    apiKey: "sk-memory-plaintext", // Pragma: allowlist secret
                  },
                },
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const plan: SecretsApplyPlan = {
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      options: {
        scrubAuthProfilesForProviderTargets: false,
        scrubEnv: false,
        scrubLegacyAuthJson: false,
      },
      protocolVersion: 1,
      targets: [
        {
          path: "agents.list.0.memorySearch.remote.apiKey",
          pathSegments: ["agents", "list", "0", "memorySearch", "remote", "apiKey"],
          ref: { id: "MEMORY_REMOTE_API_KEY", provider: "default", source: "env" },
          type: "agents.list[].memorySearch.remote.apiKey",
        },
      ],
      version: 1,
    };

    fixture.env.MEMORY_REMOTE_API_KEY = "sk-memory-live-env"; // Pragma: allowlist secret
    const nextConfig = (await applyTesting.projectConfigForTest({
      env: fixture.env,
      plan,
    })) as {
      agents?: {
        list?: {
          memorySearch?: {
            remote?: {
              apiKey?: unknown;
            };
          };
        }[];
      };
    };
    expect(nextConfig.agents?.list?.[0]?.memorySearch?.remote?.apiKey).toEqual({
      id: "MEMORY_REMOTE_API_KEY",
      provider: "default",
      source: "env",
    });
  });

  it("rejects plan targets that do not match allowed secret-bearing paths", async () => {
    const plan: SecretsApplyPlan = {
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      protocolVersion: 1,
      targets: [
        {
          path: "models.providers.openai.baseUrl",
          pathSegments: ["models", "providers", "openai", "baseUrl"],
          providerId: "openai",
          ref: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          type: "models.providers.apiKey",
        },
      ],
      version: 1,
    };

    await expect(runSecretsApply({ env: fixture.env, plan, write: false })).rejects.toThrow(
      "Invalid plan target path",
    );
  });

  it("rejects plan targets with forbidden prototype-like path segments", async () => {
    const plan: SecretsApplyPlan = {
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      protocolVersion: 1,
      targets: [
        {
          path: "skills.entries.__proto__.apiKey",
          pathSegments: ["skills", "entries", "__proto__", "apiKey"],
          ref: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          type: "skills.entries.apiKey",
        },
      ],
      version: 1,
    };

    await expect(runSecretsApply({ env: fixture.env, plan, write: false })).rejects.toThrow(
      "Invalid plan target path",
    );
  });

  it("applies provider upserts and deletes from plan", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
      secrets: {
        providers: {
          envmain: { source: "env" },
          fileold: { mode: "json", path: "/tmp/old-secrets.json", source: "file" },
        },
      },
    });

    const plan = createPlan({
      providerDeletes: ["fileold"],
      providerUpserts: {
        filemain: {
          mode: "json",
          path: "/tmp/new-secrets.json",
          source: "file",
        },
      },
      targets: [],
    });

    const nextConfig = (await applyTesting.projectConfigForTest({
      env: fixture.env,
      plan,
    })) as {
      secrets?: {
        providers?: Record<string, unknown>;
      };
    };
    expect(nextConfig.secrets?.providers?.fileold).toBeUndefined();
    expect(nextConfig.secrets?.providers?.filemain).toEqual({
      mode: "json",
      path: "/tmp/new-secrets.json",
      source: "file",
    });
  });
});
