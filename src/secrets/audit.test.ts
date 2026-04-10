import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecretsAudit } from "./audit.js";

interface AuditFixture {
  rootDir: string;
  stateDir: string;
  configPath: string;
  authStorePath: string;
  authJsonPath: string;
  modelsPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
}

const OPENAI_API_KEY_MARKER = "OPENAI_API_KEY"; // Pragma: allowlist secret
const MAX_AUDIT_MODELS_JSON_BYTES = 5 * 1024 * 1024;

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeExecResolverShellScript(params: {
  scriptPath: string;
  logPath: string;
  values: Record<string, string>;
}) {
  await fs.writeFile(
    params.scriptPath,
    [
      "#!/bin/sh",
      `printf 'x\\n' >> ${JSON.stringify(params.logPath)}`,
      "cat >/dev/null",
      `printf '${JSON.stringify({ protocolVersion: 1, values: params.values }).replaceAll("'", String.raw`'\''`)}'`, // Pragma: allowlist secret
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
}

async function writeExecSecretsAuditConfig(params: {
  fixture: AuditFixture;
  execScriptPath: string;
  providers: {
    id: string;
    baseUrl: string;
    modelId: string;
    modelName: string;
  }[];
}) {
  await writeJsonFile(params.fixture.configPath, {
    models: {
      providers: Object.fromEntries(
        params.providers.map((provider) => [
          provider.id,
          {
            api: "openai-completions",
            apiKey: {
              id: `providers/${provider.id}/apiKey`,
              provider: "execmain",
              source: "exec",
            },
            baseUrl: provider.baseUrl,
            models: [{ id: provider.modelId, name: provider.modelName }],
          },
        ]),
      ),
    },
    secrets: {
      providers: {
        execmain: {
          command: params.execScriptPath,
          jsonOnly: true,
          noOutputTimeoutMs: 10_000,
          source: "exec",
          timeoutMs: 20_000,
        },
      },
    },
  });
}

function resolveRuntimePathEnv(): string {
  if (typeof process.env.PATH === "string" && process.env.PATH.trim().length > 0) {
    return process.env.PATH;
  }
  return "/usr/bin:/bin";
}

function hasFinding(
  report: Awaited<ReturnType<typeof runSecretsAudit>>,
  predicate: (entry: { code: string; file: string; jsonPath?: string }) => boolean,
): boolean {
  return report.findings.some((entry) =>
    predicate(entry as { code: string; file: string; jsonPath?: string }),
  );
}

async function createAuditFixture(): Promise<AuditFixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-"));
  const stateDir = path.join(rootDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const authJsonPath = path.join(stateDir, "agents", "main", "agent", "auth.json");
  const modelsPath = path.join(stateDir, "agents", "main", "agent", "models.json");
  const envPath = path.join(stateDir, ".env");

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.dirname(authStorePath), { recursive: true });

  return {
    authJsonPath,
    authStorePath,
    configPath,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "env-openai-key", // Pragma: allowlist secret
      PATH: resolveRuntimePathEnv(),
    },
    envPath,
    modelsPath,
    rootDir,
    stateDir,
  };
}

async function seedAuditFixture(fixture: AuditFixture): Promise<void> {
  const seededProvider = {
    openai: {
      api: "openai-completions",
      apiKey: { id: OPENAI_API_KEY_MARKER, provider: "default", source: "env" },
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-5", name: "gpt-5" }],
    },
  };
  const seededProfiles = new Map<string, Record<string, string>>([
    [
      "openai:default",
      {
        key: "sk-openai-plaintext",
        provider: "openai",
        type: "api_key",
      },
    ],
  ]);
  await writeJsonFile(fixture.configPath, {
    models: { providers: seededProvider },
  });
  await writeJsonFile(fixture.authStorePath, {
    profiles: Object.fromEntries(seededProfiles),
    version: 1,
  });
  await writeJsonFile(fixture.modelsPath, {
    providers: {
      openai: {
        api: "openai-completions",
        apiKey: OPENAI_API_KEY_MARKER,
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
      },
    },
  });
  await fs.writeFile(
    fixture.envPath,
    `${OPENAI_API_KEY_MARKER}=sk-openai-plaintext\n`, // Pragma: allowlist secret
    "utf8",
  );
}

describe("secrets audit", () => {
  let fixture: AuditFixture;

  async function writeModelsProvider(
    overrides: Partial<{
      apiKey: unknown;
      headers: Record<string, unknown>;
    }> = {},
  ) {
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        openai: {
          api: "openai-completions",
          apiKey: OPENAI_API_KEY_MARKER,
          baseUrl: "https://api.openai.com/v1",
          models: [{ id: "gpt-5", name: "gpt-5" }],
          ...overrides,
        },
      },
    });
  }

  function expectModelsFinding(
    report: Awaited<ReturnType<typeof runSecretsAudit>>,
    params: { code: string; jsonPath?: string; present?: boolean },
  ) {
    expect(
      hasFinding(
        report,
        (entry) =>
          entry.code === params.code &&
          entry.file === fixture.modelsPath &&
          (params.jsonPath === undefined || entry.jsonPath === params.jsonPath),
      ),
    ).toBe(params.present ?? true);
  }

  beforeEach(async () => {
    fixture = await createAuditFixture();
    await seedAuditFixture(fixture);
  });

  afterEach(async () => {
    await fs.rm(fixture.rootDir, { force: true, recursive: true });
  });

  it("reports plaintext + shadowing findings", async () => {
    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.status).toBe("findings");
    expect(report.summary.plaintextCount).toBeGreaterThan(0);
    expect(report.summary.shadowedRefCount).toBeGreaterThan(0);
    expect(hasFinding(report, (entry) => entry.code === "REF_SHADOWED")).toBe(true);
    expect(hasFinding(report, (entry) => entry.code === "PLAINTEXT_FOUND")).toBe(true);
  });

  it("does not mutate legacy auth.json during audit", async () => {
    await fs.rm(fixture.authStorePath, { force: true });
    await writeJsonFile(fixture.authJsonPath, {
      openai: {
        key: "sk-legacy-auth-json",
        type: "api_key",
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expect(hasFinding(report, (entry) => entry.code === "LEGACY_RESIDUE")).toBe(true);
    await expect(fs.stat(fixture.authJsonPath)).resolves.toBeTruthy();
    await expect(fs.stat(fixture.authStorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports malformed sidecar JSON as findings instead of crashing", async () => {
    await fs.writeFile(fixture.authStorePath, "{invalid-json", "utf8");
    await fs.writeFile(fixture.authJsonPath, "{invalid-json", "utf8");

    const report = await runSecretsAudit({ env: fixture.env });
    expect(hasFinding(report, (entry) => entry.file === fixture.authStorePath)).toBe(true);
    expect(hasFinding(report, (entry) => entry.file === fixture.authJsonPath)).toBe(true);
    expect(hasFinding(report, (entry) => entry.code === "REF_UNRESOLVED")).toBe(true);
  });

  it("skips exec ref resolution during audit unless explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls-skipped.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver-skipped.sh");
    await writeExecResolverShellScript({
      logPath: execLogPath,
      scriptPath: execScriptPath,
      values: {
        "providers/openai/apiKey": "value:providers/openai/apiKey",
      },
    });
    await writeExecSecretsAuditConfig({
      execScriptPath,
      fixture,
      providers: [
        {
          baseUrl: "https://api.openai.com/v1",
          id: "openai",
          modelId: "gpt-5",
          modelName: "gpt-5",
        },
      ],
    });
    await fs.rm(fixture.authStorePath, { force: true });
    await fs.writeFile(fixture.envPath, "", "utf8");

    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.resolution.resolvabilityComplete).toBe(false);
    expect(report.resolution.skippedExecRefs).toBe(1);
    expect(report.summary.unresolvedRefCount).toBe(0);
    await expect(fs.stat(execLogPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("batches ref resolution per provider during audit when --allow-exec is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await writeExecResolverShellScript({
      logPath: execLogPath,
      scriptPath: execScriptPath,
      values: {
        "providers/moonshot/apiKey": "value:providers/moonshot/apiKey",
        "providers/openai/apiKey": "value:providers/openai/apiKey",
      },
    });
    await writeExecSecretsAuditConfig({
      execScriptPath,
      fixture,
      providers: [
        {
          baseUrl: "https://api.openai.com/v1",
          id: "openai",
          modelId: "gpt-5",
          modelName: "gpt-5",
        },
        {
          baseUrl: "https://api.moonshot.cn/v1",
          id: "moonshot",
          modelId: "moonshot-v1-8k",
          modelName: "moonshot-v1-8k",
        },
      ],
    });
    await fs.rm(fixture.authStorePath, { force: true });
    await fs.writeFile(fixture.envPath, "", "utf8");

    const report = await runSecretsAudit({ allowExec: true, env: fixture.env });
    expect(report.summary.unresolvedRefCount).toBe(0);

    const callLog = await fs.readFile(execLogPath, "utf8");
    const callCount = callLog.split("\n").filter((line) => line.trim().length > 0).length;
    expect(callCount).toBe(1);
  });

  it("short-circuits per-ref fallback for provider-wide batch failures when --allow-exec is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-fail-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver-fail.mjs");
    await fs.writeFile(
      execScriptPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(execLogPath)}, 'x\\n');`,
        "process.exit(1);",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );

    await fs.writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              moonshot: {
                api: "openai-completions",
                apiKey: { id: "providers/moonshot/apiKey", provider: "execmain", source: "exec" },
                baseUrl: "https://api.moonshot.cn/v1",
                models: [{ id: "moonshot-v1-8k", name: "moonshot-v1-8k" }],
              },
              openai: {
                api: "openai-completions",
                apiKey: { id: "providers/openai/apiKey", provider: "execmain", source: "exec" },
                baseUrl: "https://api.openai.com/v1",
                models: [{ id: "gpt-5", name: "gpt-5" }],
              },
            },
          },
          secrets: {
            providers: {
              execmain: {
                command: execScriptPath,
                jsonOnly: true,
                passEnv: ["PATH"],
                source: "exec",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.rm(fixture.authStorePath, { force: true });
    await fs.writeFile(fixture.envPath, "", "utf8");

    const report = await runSecretsAudit({ allowExec: true, env: fixture.env });
    expect(report.summary.unresolvedRefCount).toBeGreaterThanOrEqual(2);

    const callLog = await fs.readFile(execLogPath, "utf8");
    const callCount = callLog.split("\n").filter((line) => line.trim().length > 0).length;
    expect(callCount).toBe(1);
  });

  it("scans agent models.json files for plaintext provider apiKey values", async () => {
    await writeModelsProvider({ apiKey: "sk-models-plaintext" }); // Pragma: allowlist secret

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
    });
    expect(report.filesScanned).toContain(fixture.modelsPath);
  });

  it("scans agent models.json files for plaintext provider header values", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: "Bearer sk-header-plaintext", // Pragma: allowlist secret
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.Authorization",
    });
  });

  it("does not flag non-sensitive routing headers in models.json", async () => {
    await writeModelsProvider({
      headers: {
        "X-Proxy-Region": "us-west",
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.X-Proxy-Region",
      present: false,
    });
  });

  it("does not flag models.json marker values as plaintext", async () => {
    await writeModelsProvider();

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
      present: false,
    });
  });

  it("flags arbitrary all-caps models.json apiKey values as plaintext", async () => {
    await writeModelsProvider({ apiKey: "ALLCAPS_SAMPLE" }); // Pragma: allowlist secret

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
    });
  });

  it("does not flag models.json header marker values as plaintext", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: "secretref-env:OPENAI_HEADER_TOKEN", // Pragma: allowlist secret
        "x-managed-token": "secretref-managed", // Pragma: allowlist secret
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.Authorization",
      present: false,
    });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.x-managed-token",
      present: false,
    });
  });

  it("reports unresolved models.json SecretRef objects in provider headers", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: {
          id: "OPENAI_HEADER_TOKEN",
          provider: "default",
          source: "env", // Pragma: allowlist secret
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "REF_UNRESOLVED",
      jsonPath: "providers.openai.headers.Authorization",
    });
  });

  it("reports malformed models.json as unresolved findings", async () => {
    await fs.writeFile(fixture.modelsPath, "{bad-json", "utf8");
    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, { code: "REF_UNRESOLVED" });
  });

  it("reports non-regular models.json files as unresolved findings", async () => {
    await fs.rm(fixture.modelsPath, { force: true });
    await fs.mkdir(fixture.modelsPath, { recursive: true });
    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, { code: "REF_UNRESOLVED" });
  });

  it("reports oversized models.json as unresolved findings", async () => {
    const oversizedApiKey = "a".repeat(MAX_AUDIT_MODELS_JSON_BYTES + 256);
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        openai: {
          api: "openai-completions",
          apiKey: oversizedApiKey,
          baseUrl: "https://api.openai.com/v1",
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, { code: "REF_UNRESOLVED" });
  });

  it("scans active agent-dir override models.json even when outside state dir", async () => {
    const externalAgentDir = path.join(fixture.rootDir, "external-agent");
    const externalModelsPath = path.join(externalAgentDir, "models.json");
    await fs.mkdir(externalAgentDir, { recursive: true });
    await writeJsonFile(externalModelsPath, {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "sk-external-plaintext", // Pragma: allowlist secret
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    });

    const report = await runSecretsAudit({
      env: {
        ...fixture.env,
        OPENCLAW_AGENT_DIR: externalAgentDir,
      },
    });
    expect(
      hasFinding(
        report,
        (entry) =>
          entry.code === "PLAINTEXT_FOUND" &&
          entry.file === externalModelsPath &&
          entry.jsonPath === "providers.openai.apiKey",
      ),
    ).toBe(true);
    expect(report.filesScanned).toContain(externalModelsPath);
  });

  it("does not flag non-sensitive routing headers in openclaw config", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            apiKey: { id: OPENAI_API_KEY_MARKER, provider: "default", source: "env" },
            baseUrl: "https://api.openai.com/v1",
            headers: {
              "X-Proxy-Region": "us-west",
            },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });
    await writeJsonFile(fixture.authStorePath, {
      profiles: {},
      version: 1,
    });
    await fs.writeFile(fixture.envPath, "", "utf8");

    const report = await runSecretsAudit({ env: fixture.env });
    expect(
      hasFinding(
        report,
        (entry) =>
          entry.code === "PLAINTEXT_FOUND" &&
          entry.file === fixture.configPath &&
          entry.jsonPath === "models.providers.openai.headers.X-Proxy-Region",
      ),
    ).toBe(false);
  });
});
