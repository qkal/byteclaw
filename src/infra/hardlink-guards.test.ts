import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { assertNoHardlinkedFinalPath } from "./hardlink-guards.js";

async function withHardlinkFixture(
  cb: (context: { root: string; source: string; linked: string; dirPath: string }) => Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-hardlink-guards-" }, async (root) => {
    const dirPath = path.join(root, "dir");
    const source = path.join(root, "source.txt");
    const linked = path.join(root, "linked.txt");
    await fs.mkdir(dirPath);
    await fs.writeFile(source, "hello", "utf8");
    await fs.link(source, linked);
    await cb({ dirPath, linked, root, source });
  });
}

describe("assertNoHardlinkedFinalPath", () => {
  it.each([
    {
      filePath: ({ root }: { root: string }) => path.join(root, "missing.txt"),
      name: "allows missing paths",
      opts: {},
    },
    {
      filePath: ({ dirPath }: { dirPath: string }) => dirPath,
      name: "allows directories",
      opts: {},
    },
    {
      filePath: ({ linked }: { linked: string }) => linked,
      name: "allows explicit unlink opt-in",
      opts: { allowFinalHardlinkForUnlink: true },
    },
  ])("$name", async ({ filePath, opts }) => {
    await withHardlinkFixture(async (context) => {
      await expect(
        assertNoHardlinkedFinalPath({
          boundaryLabel: "workspace",
          filePath: filePath(context),
          root: context.root,
          ...opts,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects hardlinked files and shortens home-relative paths in the error", async () => {
    await withHardlinkFixture(async ({ root, linked }) => {
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(root);
      const expectedLinkedPath = path.join("~", "linked.txt");

      try {
        await expect(
          assertNoHardlinkedFinalPath({
            boundaryLabel: "workspace",
            filePath: linked,
            root,
          }),
        ).rejects.toThrow(
          `Hardlinked path is not allowed under workspace (~): ${expectedLinkedPath}`,
        );
      } finally {
        homedirSpy.mockRestore();
      }
    });
  });
});
