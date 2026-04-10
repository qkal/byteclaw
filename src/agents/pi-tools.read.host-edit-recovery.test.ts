import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxFsBridge, SandboxFsStat } from "./sandbox/fs-bridge.js";

function createInMemoryBridge(root: string, files: Map<string, string>): SandboxFsBridge {
  const resolveAbsolute = (filePath: string, cwd?: string) =>
    path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd ?? root, filePath);

  const readStat = (absolutePath: string): SandboxFsStat | null => {
    const content = files.get(absolutePath);
    if (typeof content !== "string") {
      return null;
    }
    return {
      mtimeMs: 0,
      size: Buffer.byteLength(content, "utf8"),
      type: "file",
    };
  };

  return {
    mkdirp: async () => {},
    readFile: async ({ filePath, cwd }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      const content = files.get(absolutePath);
      if (typeof content !== "string") {
        throw new Error(`ENOENT: ${absolutePath}`);
      }
      return Buffer.from(content, "utf8");
    },
    remove: async ({ filePath, cwd }) => {
      files.delete(resolveAbsolute(filePath, cwd));
    },
    rename: async ({ from, to, cwd }) => {
      const fromPath = resolveAbsolute(from, cwd);
      const toPath = resolveAbsolute(to, cwd);
      const content = files.get(fromPath);
      if (typeof content !== "string") {
        throw new Error(`ENOENT: ${fromPath}`);
      }
      files.set(toPath, content);
      files.delete(fromPath);
    },
    resolvePath: ({ filePath, cwd }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      return {
        containerPath: absolutePath,
        hostPath: absolutePath,
        relativePath: path.relative(root, absolutePath),
      };
    },
    stat: async ({ filePath, cwd }) => readStat(resolveAbsolute(filePath, cwd)),
    writeFile: async ({ filePath, cwd, data }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      files.set(absolutePath, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
  };
}

describe("edit tool recovery hardening", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { force: true, recursive: true });
      tmpDir = "";
    }
  });

  function createRecoveredEditTool(params: {
    root: string;
    readFile: (absolutePath: string) => Promise<string>;
    execute: AnyAgentTool["execute"];
  }) {
    const base = {
      execute: params.execute,
      name: "edit",
    } as unknown as AnyAgentTool;
    return wrapEditToolWithRecovery(base, {
      readFile: params.readFile,
      root: params.root,
    });
  }

  it("adds current file contents to exact-match mismatch errors", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "actual current content", "utf8");

    const tool = createRecoveredEditTool({
      execute: async () => {
        throw new Error(
          "Could not find the exact text in demo.txt. The old text must match exactly including all whitespace and newlines.",
        );
      },
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf8"),
      root: tmpDir,
    });
    await expect(
      tool.execute(
        "call-1",
        { edits: [{ newText: "replacement", oldText: "missing" }], path: filePath },
        undefined,
      ),
    ).rejects.toThrow(/Current file contents:\nactual current content/);
  });

  it("recovers success after a post-write throw when CRLF output contains newText and oldText is only a substring", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, 'const value = "foo";\r\n', "utf8");

    const tool = createRecoveredEditTool({
      execute: async () => {
        await fs.writeFile(filePath, 'const value = "foobar";\r\n', "utf8");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf8"),
      root: tmpDir,
    });
    const result = await tool.execute(
      "call-1",
      {
        edits: [
          {
            newText: 'const value = "foobar";\n',
            oldText: 'const value = "foo";\n',
          },
        ],
        path: filePath,
      },
      undefined,
    );

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      text: `Successfully replaced text in ${filePath}.`,
      type: "text",
    });
  });

  it("does not recover false success when the file never changed", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "replacement already present", "utf8");

    const tool = createRecoveredEditTool({
      execute: async () => {
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf8"),
      root: tmpDir,
    });
    await expect(
      tool.execute(
        "call-1",
        {
          edits: [{ newText: "replacement already present", oldText: "missing" }],
          path: filePath,
        },
        undefined,
      ),
    ).rejects.toThrow("Simulated post-write failure");
  });

  it("recovers deletion edits when the file changed and oldText is gone", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "before delete me after\n", "utf8");

    const tool = createRecoveredEditTool({
      execute: async () => {
        await fs.writeFile(filePath, "before  after\n", "utf8");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf8"),
      root: tmpDir,
    });
    const result = await tool.execute(
      "call-1",
      { edits: [{ newText: "", oldText: "delete me" }], path: filePath },
      undefined,
    );

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      text: `Successfully replaced text in ${filePath}.`,
      type: "text",
    });
  });

  it("recovers multi-edit payloads after a post-write throw", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "alpha beta gamma delta\n", "utf8");

    const tool = createRecoveredEditTool({
      execute: async () => {
        await fs.writeFile(filePath, "ALPHA beta gamma DELTA\n", "utf8");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf8"),
      root: tmpDir,
    });
    const result = await tool.execute(
      "call-1",
      {
        edits: [
          { newText: "ALPHA", oldText: "alpha" },
          { newText: "DELTA", oldText: "delta" },
        ],
        path: filePath,
      },
      undefined,
    );

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      text: `Successfully replaced 2 block(s) in ${filePath}.`,
      type: "text",
    });
  });

  it("applies the same recovery path to sandboxed edit tools", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    const files = new Map<string, string>([[filePath, "before old text after\n"]]);

    const bridge = createInMemoryBridge(tmpDir, files);
    const tool = createRecoveredEditTool({
      execute: async () => {
        files.set(filePath, "before new text after\n");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
      readFile: async (absolutePath: string) =>
        (await bridge.readFile({ cwd: tmpDir, filePath: absolutePath })).toString("utf8"),
      root: tmpDir,
    });
    const result = await tool.execute(
      "call-1",
      { edits: [{ newText: "new text", oldText: "old text" }], path: filePath },
      undefined,
    );

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      text: `Successfully replaced text in ${filePath}.`,
      type: "text",
    });
  });
});
