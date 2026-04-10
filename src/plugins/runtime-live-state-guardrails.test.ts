import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledPluginFile } from "../../test/helpers/bundled-plugin-paths.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const LIVE_RUNTIME_STATE_GUARDS: Record<
  string,
  {
    required: readonly string[];
    forbidden: readonly string[];
  }
> = {
  [bundledPluginFile("whatsapp", "src/active-listener.ts")]: {
    forbidden: ["resolveGlobalSingleton"],
    required: ["globalThis", 'Symbol.for("openclaw.whatsapp.activeListenerState")'],
  },
};

function guardAssertions() {
  return Object.entries(LIVE_RUNTIME_STATE_GUARDS).flatMap(([relativePath, guard]) => [
    ...guard.required.map((needle) => ({
      message: `${relativePath} missing ${needle}`,
      needle,
      relativePath,
      type: "required" as const,
    })),
    ...guard.forbidden.map((needle) => ({
      message: `${relativePath} must not contain ${needle}`,
      needle,
      relativePath,
      type: "forbidden" as const,
    })),
  ]);
}

function expectGuardState(params: {
  source: string;
  type: "required" | "forbidden";
  needle: string;
  message: string;
}) {
  if (params.type === "required") {
    expect(params.source, params.message).toContain(params.needle);
    return;
  }
  expect(params.source, params.message).not.toContain(params.needle);
}

function readGuardrailSource(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("runtime live state guardrails", () => {
  it.each(guardAssertions())(
    "keeps split-runtime state holders on explicit direct globals: $relativePath $type $needle",
    ({ relativePath, type, needle, message }) => {
      expectGuardState({
        message,
        needle,
        source: readGuardrailSource(relativePath),
        type,
      });
    },
  );
});
