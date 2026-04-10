import { describe, expect, it } from "vitest";
import {
  type PackageManagerCommandRunner,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";

describe("resolveUpdateBuildManager", () => {
  it("bootstraps pnpm via npm when pnpm and corepack are unavailable", async () => {
    const paths: string[] = [];
    const runCommand: PackageManagerCommandRunner = async (argv, options) => {
      const key = argv.join(" ");
      if (key === "pnpm --version") {
        const envPath = options.env?.PATH ?? options.env?.Path ?? "";
        if (envPath.includes("openclaw-update-pnpm-")) {
          paths.push(envPath);
          return { code: 0, stderr: "", stdout: "10.0.0" };
        }
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { code: 0, stderr: "", stdout: "10.0.0" };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@10")) {
        return { code: 0, stderr: "", stdout: "added 1 package" };
      }
      return { code: 0, stderr: "", stdout: "" };
    };

    const result = await resolveUpdateBuildManager(runCommand, process.cwd(), 5000, undefined);

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.manager).toBe("pnpm");
      expect(paths.some((value) => value.includes("openclaw-update-pnpm-"))).toBe(true);
      await result.cleanup?.();
    }
  });

  it("returns a specific bootstrap failure when pnpm cannot be installed from npm", async () => {
    const runCommand: PackageManagerCommandRunner = async (argv) => {
      const key = argv.join(" ");
      if (key === "pnpm --version") {
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { code: 0, stderr: "", stdout: "10.0.0" };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@10")) {
        return { code: 1, stderr: "network exploded", stdout: "" };
      }
      return { code: 0, stderr: "", stdout: "" };
    };

    const result = await resolveUpdateBuildManager(
      runCommand,
      process.cwd(),
      5000,
      undefined,
      "require-preferred",
    );

    expect(result).toEqual({
      kind: "missing-required",
      preferred: "pnpm",
      reason: "pnpm-npm-bootstrap-failed",
    });
  });
});
