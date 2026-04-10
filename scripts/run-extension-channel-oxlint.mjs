#!/usr/bin/env node

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const args = process.argv.slice(2);
const fixFlag = args.includes("--fix") ? "--fix" : "";

try {
  const extensionsDir = join(rootDir, "extensions");
  const channelExtensions = [
    "discord",
    "slack",
    "telegram",
    "whatsapp",
    "matrix",
    "irc",
    "googlechat",
    "line",
    "feishu",
    "mattermost",
  ];

  for (const ext of channelExtensions) {
    const extPath = join(extensionsDir, ext);
    try {
      const command = `npx oxlint ${fixFlag} --plugin tsgolint`;
      console.log(`Running oxlint on ${ext}: ${command}`);
      execSync(command, {
        cwd: extPath,
        stdio: "inherit",
      });
    } catch (error) {
      console.error(`Error linting ${ext}:`, error.message);
      process.exit(error.status || 1);
    }
  }
} catch (error) {
  console.error("Error:", error.message);
  process.exit(1);
}
