import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

const BUNDLED_EXTENSION_CONFIG_IMPORT_GUARDS = [
  {
    allowedSpecifier: "../config-api.js",
    path: "extensions/telegram/src/config-schema.ts",
  },
  {
    allowedSpecifier: "../config-api.js",
    path: "extensions/discord/src/config-schema.ts",
  },
  {
    allowedSpecifier: "../config-api.js",
    path: "extensions/slack/src/config-schema.ts",
  },
  {
    allowedSpecifier: "../config-api.js",
    path: "extensions/signal/src/config-schema.ts",
  },
  {
    allowedSpecifier: "../config-api.js",
    path: "extensions/imessage/src/config-schema.ts",
  },
  {
    allowedSpecifier: "../config-api.js",
    path: "extensions/whatsapp/src/config-schema.ts",
  },
  {
    allowedSpecifier: "openclaw/plugin-sdk/googlechat",
    path: "extensions/googlechat/src/config-schema.ts",
  },
  // Teams keeps a package-local config barrel so production code does not
  // Self-import via openclaw/plugin-sdk/msteams from inside the same extension.
  {
    allowedSpecifier: "../config-api.js",
    path: "extensions/msteams/src/config-schema.ts",
  },
] as const;

describe("bundled extension config api guardrails", () => {
  for (const entry of BUNDLED_EXTENSION_CONFIG_IMPORT_GUARDS) {
    it(`keeps ${entry.path} off the generic concrete-schema barrel`, () => {
      const source = readFileSync(resolve(REPO_ROOT, entry.path), "utf8");
      expect(source).toContain(entry.allowedSpecifier);
      expect(source).not.toContain("openclaw/plugin-sdk/channel-config-schema");
    });
  }
});
