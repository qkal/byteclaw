import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";

const QA_FRONTIER_PROVIDER_IDS = ["anthropic", "google", "openai"] as const;

interface ModelRow {
  key: string;
  name: string;
  input: string;
  available: boolean | null;
  missing: boolean;
}

export interface QaRunnerModelOption {
  key: string;
  name: string;
  provider: string;
  input: string;
  preferred: boolean;
}

function splitModelKey(key: string) {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) {
    return null;
  }
  return {
    model: key.slice(slash + 1),
    provider: key.slice(0, slash),
  };
}

export function selectQaRunnerModelOptions(rows: ModelRow[]): QaRunnerModelOption[] {
  const options = rows
    .filter((row) => row.available === true && !row.missing)
    .map((row) => {
      const parsed = splitModelKey(row.key);
      return {
        input: row.input,
        key: row.key,
        name: row.name,
        preferred: row.key === "openai/gpt-5.4",
        provider: parsed?.provider ?? "unknown",
      } satisfies QaRunnerModelOption;
    });

  return options.toSorted((left, right) => {
    if (left.preferred !== right.preferred) {
      return left.preferred ? -1 : 1;
    }
    const providerCompare = left.provider.localeCompare(right.provider);
    if (providerCompare !== 0) {
      return providerCompare;
    }
    return left.name.localeCompare(right.name);
  });
}

export async function loadQaRunnerModelOptions(params: { repoRoot: string }) {
  const tempRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-qa-model-catalog-"),
  );
  const workspaceDir = path.join(tempRoot, "workspace");
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const configPath = path.join(tempRoot, "openclaw.json");

  try {
    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(homeDir, { recursive: true }),
    ]);
    const cfg = buildQaGatewayConfig({
      alternateModel: "anthropic/claude-sonnet-4-6",
      bind: "loopback",
      controlUiEnabled: false,
      enabledProviderIds: [...QA_FRONTIER_PROVIDER_IDS],
      gatewayPort: 0,
      gatewayToken: "qa-model-catalog",
      imageGenerationModel: null,
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      qaBusBaseUrl: "http://127.0.0.1:9",
      workspaceDir,
    });
    await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["dist/index.js", "models", "list", "--all", "--json"],
        {
          cwd: params.repoRoot,
          env: {
            ...process.env,
            HOME: homeDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_HOME: homeDir,
            OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
            OPENCLAW_STATE_DIR: stateDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `qa model catalog failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      });
    });

    const payload = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { models?: ModelRow[] };
    return selectQaRunnerModelOptions(payload.models ?? []);
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}
