import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooksFromPath } from "./install.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "./internal-hooks.js";
import { loadInternalHooks } from "./loader.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hooks-e2e-"));
  tempDirs.push(dir);
  return dir;
}

describe("hooks install (e2e)", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    const baseDir = await makeTempDir();
    workspaceDir = path.join(baseDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      try {
        await fs.rm(dir, { force: true, recursive: true });
      } catch {
        // Ignore cleanup failures
      }
    }
  });

  it("installs a hook pack and triggers the handler", async () => {
    const baseDir = await makeTempDir();
    const packDir = path.join(baseDir, "hook-pack");
    const hookDir = path.join(packDir, "hooks", "hello-hook");
    await fs.mkdir(hookDir, { recursive: true });

    await fs.writeFile(
      path.join(packDir, "package.json"),
      JSON.stringify(
        {
          name: "@acme/hello-hooks",
          openclaw: { hooks: ["./hooks/hello-hook"] },
          version: "0.0.0",
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        'name: "hello-hook"',
        'description: "Test hook"',
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# Hello Hook",
        "",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(hookDir, "handler.js"),
      "export default async function(event) { event.messages.push('hook-ok'); }\n",
      "utf8",
    );

    const hooksDir = path.join(baseDir, "managed-hooks");
    const installResult = await installHooksFromPath({ hooksDir, path: packDir });
    expect(installResult.ok).toBe(true);
    if (!installResult.ok) {
      return;
    }

    clearInternalHooks();
    const bundledHooksDir = path.join(baseDir, "bundled-none");
    await fs.mkdir(bundledHooksDir, { recursive: true });
    const loaded = await loadInternalHooks(
      {
        hooks: {
          internal: {
            enabled: true,
            load: { extraDirs: [hooksDir] },
          },
        },
      },
      workspaceDir,
      { bundledHooksDir, managedHooksDir: hooksDir },
    );
    expect(loaded).toBeGreaterThanOrEqual(1);

    const event = createInternalHookEvent("command", "new", "test-session");
    await triggerInternalHook(event);
    expect(event.messages).toContain("hook-ok");
  });
});
