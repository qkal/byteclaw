import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

export function mockSessionsConfig() {
  vi.mock("../config/config.js", async () => {
    const actual =
      await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
    return {
      ...actual,
      loadConfig: () => ({
        agents: {
          defaults: {
            contextTokens: 32_000,
            model: { primary: "pi:opus" },
            models: { "pi:opus": {} },
          },
        },
      }),
    };
  });
}

export function makeRuntime(params?: { throwOnError?: boolean }): {
  runtime: RuntimeEnv;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const throwOnError = params?.throwOnError ?? false;
  return {
    errors,
    logs,
    runtime: {
      error: (msg: unknown) => {
        errors.push(String(msg));
        if (throwOnError) {
          throw new Error(String(msg));
        }
      },
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
      log: (msg: unknown) => logs.push(String(msg)),
    },
  };
}

export function writeStore(data: unknown, prefix = "sessions"): string {
  const fileName = `${[prefix, Date.now(), randomUUID()].join("-")}.json`;
  const file = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export async function runSessionsJson<T>(
  run: (
    opts: { json?: boolean; store?: string; active?: string },
    runtime: RuntimeEnv,
  ) => Promise<void>,
  store: string,
  options?: {
    active?: string;
  },
): Promise<T> {
  const { runtime, logs } = makeRuntime();
  try {
    await run(
      {
        active: options?.active,
        json: true,
        store,
      },
      runtime,
    );
  } finally {
    fs.rmSync(store, { force: true });
  }
  return JSON.parse(logs[0] ?? "{}") as T;
}
