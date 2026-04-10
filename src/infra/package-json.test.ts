import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { readPackageName, readPackageVersion } from "./package-json.js";

async function expectPackageMeta(params: {
  root: string;
  expectedVersion: string | null;
  expectedName: string | null;
}): Promise<void> {
  await expect(readPackageVersion(params.root)).resolves.toBe(params.expectedVersion);
  await expect(readPackageName(params.root)).resolves.toBe(params.expectedName);
}

describe("package-json helpers", () => {
  it("reads package version and trims package name", async () => {
    await withTempDir({ prefix: "openclaw-package-json-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "  @openclaw/demo  ", version: " 1.2.3 " }),
        "utf8",
      );

      await expectPackageMeta({
        expectedName: "@openclaw/demo",
        expectedVersion: "1.2.3",
        root,
      });
    });
  });

  it.each([
    {
      expectedName: null,
      expectedVersion: null,
      name: "missing package.json",
      writePackageJson: async (_root: string) => {},
    },
    {
      expectedName: null,
      expectedVersion: null,
      name: "invalid JSON",
      writePackageJson: async (root: string) => {
        await fs.writeFile(path.join(root, "package.json"), "{", "utf8");
      },
    },
    {
      expectedName: null,
      expectedVersion: null,
      name: "invalid typed fields",
      writePackageJson: async (root: string) => {
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "   ", version: 123 }),
          "utf8",
        );
      },
    },
    {
      expectedName: "@openclaw/demo",
      expectedVersion: null,
      name: "blank version strings",
      writePackageJson: async (root: string) => {
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "@openclaw/demo", version: "   " }),
          "utf8",
        );
      },
    },
  ])(
    "returns normalized nulls for $name",
    async ({ writePackageJson, expectedVersion, expectedName }) => {
      await withTempDir({ prefix: "openclaw-package-json-" }, async (root) => {
        await writePackageJson(root);
        await expectPackageMeta({
          expectedName,
          expectedVersion,
          root,
        });
      });
    },
  );
});
