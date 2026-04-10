import { describe, expect, it, vi } from "vitest";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "./sandbox-media-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

describe("createSandboxBridgeReadFile", () => {
  it("delegates reads through the sandbox bridge with sandbox root cwd", async () => {
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const scopedRead = createSandboxBridgeReadFile({
      sandbox: {
        bridge: {
          readFile,
        } as unknown as SandboxFsBridge,
        root: "/tmp/sandbox-root",
      },
    });
    await expect(scopedRead("media/inbound/example.png")).resolves.toEqual(Buffer.from("ok"));
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/tmp/sandbox-root",
      filePath: "media/inbound/example.png",
    });
  });

  it("falls back to container paths when the bridge has no host path", async () => {
    const stat = vi.fn(async () => ({ mtimeMs: 1, size: 1, type: "file" }));
    const resolved = await resolveSandboxedBridgeMediaPath({
      mediaPath: "image.png",
      sandbox: {
        bridge: {
          resolvePath: ({ filePath }: { filePath: string }) => ({
            containerPath: `/sandbox/${filePath}`,
            relativePath: filePath,
          }),
          stat,
        } as unknown as SandboxFsBridge,
        root: "/tmp/sandbox-root",
      },
    });

    expect(resolved).toEqual({ resolved: "/sandbox/image.png" });
    expect(stat).not.toHaveBeenCalled();
  });
});
