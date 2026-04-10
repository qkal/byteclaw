#!/usr/bin/env node
/**
 * Dependency Vulnerability Scanner
 * Runs npm audit and generates a report
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run npm audit and parse results
 */
function runNpmAudit() {
  console.log("Running npm audit...");

  try {
    const output = execSync("npm audit --json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return JSON.parse(output);
  } catch (error) {
    // Npm audit exits with non-zero if vulnerabilities found
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        // Not JSON output, return error message
      }
    }
    throw error;
  }
}

/**
 * Count vulnerabilities by severity
 */
function countVulnerabilities(auditResult) {
  const { metadata } = auditResult;
  return {
    critical: metadata.vulnerabilities.critical,
    high: metadata.vulnerabilities.high,
    info: metadata.vulnerabilities.info,
    low: metadata.vulnerabilities.low,
    moderate: metadata.vulnerabilities.moderate,
    total: metadata.vulnerabilities.total,
  };
}

/**
 * Generate audit report
 */
function generateReport(auditResult, counts) {
  const lines = [];

  lines.push("# Dependency Vulnerability Audit Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Critical: ${counts.critical}`);
  lines.push(`- High: ${counts.high}`);
  lines.push(`- Moderate: ${counts.moderate}`);
  lines.push(`- Low: ${counts.low}`);
  lines.push(`- Info: ${counts.info}`);
  lines.push(`- Total: ${counts.total}`);
  lines.push("");

  if (counts.total > 0) {
    lines.push("## Vulnerabilities");
    lines.push("");

    const { vulnerabilities } = auditResult;

    for (const [packageName, vuln] of Object.entries(vulnerabilities)) {
      lines.push(`### ${packageName}`);
      lines.push("");
      lines.push(`- Severity: ${vuln.severity}`);
      lines.push(`- Title: ${vuln.title}`);
      lines.push(`- URL: ${vuln.url}`);
      lines.push(`- Patched versions: ${vuln.patched_versions || "None"}`);
      lines.push(`- Recommendation: ${vuln.recommendation || "See advisory"}`);
      lines.push("");
    }
  } else {
    lines.push("✓ No vulnerabilities found!");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Main function
 */
function main() {
  const rootDir = join(__dirname, "..");
  const artifactsDir = join(rootDir, ".artifacts");
  const reportPath = join(artifactsDir, "dependency-audit-report.md");

  try {
    // Create artifacts directory
    mkdirSync(artifactsDir, { recursive: true });

    // Run audit
    const auditResult = runNpmAudit();
    const counts = countVulnerabilities(auditResult);

    // Generate report
    const report = generateReport(auditResult, counts);

    // Write report
    writeFileSync(reportPath, report, "utf8");

    console.log(`Report written to: ${reportPath}`);
    console.log("");
    console.log(`Total vulnerabilities: ${counts.total}`);
    console.log(`  Critical: ${counts.critical}`);
    console.log(`  High: ${counts.high}`);
    console.log(`  Moderate: ${counts.moderate}`);
    console.log(`  Low: ${counts.low}`);

    // Exit with error if critical or high vulnerabilities found
    if (counts.critical > 0 || counts.high > 0) {
      console.error("");
      console.error("❌ Critical or high vulnerabilities found!");
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error("Audit failed:", error.message);
    process.exit(1);
  }
}

main();
