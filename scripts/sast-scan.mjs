#!/usr/bin/env node

/**
 * SAST (Static Application Security Testing) Scanner
 * Scans codebase for security vulnerabilities using multiple tools
 */

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const sastTools = [
  {
    name: "npm audit",
    command: "npm audit",
    description: "Check for vulnerable dependencies",
  },
  {
    name: "oxlint security",
    command: "npx oxlint -D suspicious -D correctness src extensions/*/src packages/*/src",
    description: "Security-focused linting",
  },
];

async function runSastScan() {
  console.log("🔒 Starting SAST Scan...\n");

  const results = [];

  for (const tool of sastTools) {
    console.log(`Running ${tool.name}: ${tool.description}`);
    try {
      execSync(tool.command, {
        cwd: rootDir,
        stdio: "inherit",
      });
      console.log(`✓ ${tool.name} passed\n`);
      results.push({ tool: tool.name, status: "passed" });
    } catch (error) {
      console.error(`✗ ${tool.name} found issues\n`);
      results.push({ tool: tool.name, status: "failed", error: error.message });
    }
  }

  console.log("\n📊 SAST Scan Summary:");
  for (const result of results) {
    const icon = result.status === "passed" ? "✓" : "✗";
    console.log(`${icon} ${result.tool}: ${result.status}`);
  }

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    console.log(`\n⚠️  ${failed.length} SAST checks failed. Review the output above.`);
    process.exit(1);
  } else {
    console.log("\n✅ All SAST checks passed.");
  }
}

runSastScan().catch((error) => {
  console.error("SAST scan failed:", error);
  process.exit(1);
});
