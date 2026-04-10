import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
} from "./secret-file.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-secret-file-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

async function expectSecretFileError(params: {
  setup: (dir: string) => Promise<string>;
  expectedMessage: (file: string) => string;
  secretLabel?: string;
  options?: Parameters<typeof readSecretFileSync>[2];
}): Promise<void> {
  const dir = await createTempDir();
  const file = await params.setup(dir);
  expect(() =>
    readSecretFileSync(file, params.secretLabel ?? "Gateway password", params.options),
  ).toThrow(params.expectedMessage(file));
}

async function createSecretPath(setup: (dir: string) => Promise<string>): Promise<string> {
  const dir = await createTempDir();
  return setup(dir);
}

describe("readSecretFileSync", () => {
  it("rejects blank file paths", () => {
    expect(() => readSecretFileSync("   ", "Gateway password")).toThrow(
      "Gateway password file path is empty.",
    );
  });

  it("reads and trims a regular secret file", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "secret.txt");
    await writeFile(file, " top-secret \n", "utf8");

    expect(readSecretFileSync(file, "Gateway password")).toBe("top-secret");
    expect(tryReadSecretFileSync(file, "Gateway password")).toBe("top-secret");
  });

  it.each([
    {
      assert: (file: string) => {
        expect(loadSecretFileSync(file, "Gateway password")).toMatchObject({
          error: expect.any(Error),
          message: expect.stringContaining(`Failed to inspect Gateway password file at ${file}:`),
          ok: false,
          resolvedPath: file,
        });
      },
      name: "surfaces resolvedPath and error details for missing files",
    },
    {
      assert: (file: string) => {
        let thrown: Error | undefined;
        try {
          readSecretFileSync(file, "Gateway password");
        } catch (error) {
          thrown = error as Error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown?.message).toContain(`Failed to inspect Gateway password file at ${file}:`);
        expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
      },
      name: "preserves the underlying cause when throwing for missing files",
    },
  ])("$name", async ({ assert }) => {
    const file = await createSecretPath(async (dir) => path.join(dir, "missing-secret.txt"));
    assert(file);
  });

  it.each([
    {
      expectedMessage: (file: string) =>
        `Gateway password file at ${file} exceeds ${DEFAULT_SECRET_FILE_MAX_BYTES} bytes.`,
      name: "rejects files larger than the secret-file limit",
      setup: async (dir: string) => {
        const file = path.join(dir, "secret.txt");
        await writeFile(file, "x".repeat(DEFAULT_SECRET_FILE_MAX_BYTES + 1), "utf8");
        return file;
      },
    },
    {
      expectedMessage: (file: string) => `Gateway password file at ${file} must be a regular file.`,
      name: "rejects non-regular files",
      setup: async (dir: string) => {
        const nestedDir = path.join(dir, "secret-dir");
        await mkdir(nestedDir);
        return nestedDir;
      },
    },
    {
      expectedMessage: (file: string) => `Gateway password file at ${file} must not be a symlink.`,
      name: "rejects symlinks when configured",
      options: { rejectSymlink: true },
      setup: async (dir: string) => {
        const target = path.join(dir, "target.txt");
        const link = path.join(dir, "secret-link.txt");
        await writeFile(target, "top-secret\n", "utf8");
        await symlink(target, link);
        return link;
      },
    },
    {
      expectedMessage: (file: string) => `Gateway password file at ${file} is empty.`,
      name: "rejects empty secret files after trimming",
      setup: async (dir: string) => {
        const file = path.join(dir, "secret.txt");
        await writeFile(file, " \n\t ", "utf8");
        return file;
      },
    },
  ])("$name", async ({ setup, expectedMessage, options }) => {
    await expectSecretFileError({ expectedMessage, options, setup });
  });

  it.each([
    {
      expected: (file: string | undefined) => ({
        message: `Gateway password file at ${file} is empty.`,
        ok: false,
        resolvedPath: file,
      }),
      helper: "load" as const,
      label: "Gateway password",
      name: "exposes resolvedPath on non-throwing read failures",
      options: undefined,
      pathValue: async () =>
        createSecretPath(async (dir) => {
          const file = path.join(dir, "secret.txt");
          await writeFile(file, " \n\t ", "utf8");
          return file;
        }),
    },
    {
      expected: () => undefined,
      helper: "try" as const,
      label: "Telegram bot token",
      name: "returns undefined from the non-throwing helper for rejected files",
      options: { rejectSymlink: true },
      pathValue: async () =>
        createSecretPath(async (dir) => {
          const target = path.join(dir, "target.txt");
          const link = path.join(dir, "secret-link.txt");
          await writeFile(target, "top-secret\n", "utf8");
          await symlink(target, link);
          return link;
        }),
    },
    {
      expected: () => undefined,
      helper: "try" as const,
      label: "Telegram bot token",
      name: "returns undefined from the non-throwing helper for blank file paths",
      options: undefined,
      pathValue: async () => "   ",
    },
    {
      expected: () => undefined,
      helper: "try" as const,
      label: "Telegram bot token",
      name: "returns undefined from the non-throwing helper for missing path values",
      options: undefined,
      pathValue: async () => undefined,
    },
  ])("$name", async ({ pathValue, label, options, helper, expected }) => {
    const file = await pathValue();
    if (helper === "load") {
      expect(loadSecretFileSync(file as string, label, options)).toMatchObject(
        (expected as (file: string | undefined) => Record<string, unknown>)(file),
      );
      return;
    }
    expect(tryReadSecretFileSync(file, label, options)).toBe((expected as () => undefined)());
  });
});
