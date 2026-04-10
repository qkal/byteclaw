import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentBootstrapHookContext,
  clearInternalHooks,
  registerInternalHook,
} from "../hooks/internal-hooks.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { DEFAULT_SOUL_FILENAME, type WorkspaceBootstrapFile } from "./workspace.js";

function makeFile(
  name: WorkspaceBootstrapFile["name"] = DEFAULT_SOUL_FILENAME,
): WorkspaceBootstrapFile {
  return {
    content: "base",
    missing: false,
    name,
    path: `/tmp/${name}`,
  };
}

describe("applyBootstrapHookOverrides", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns updated files when a hook mutates the context", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          content: "extra",
          missing: false,
          name: "EXTRA.md",
          path: "/tmp/EXTRA.md",
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const updated = await applyBootstrapHookOverrides({
      files: [makeFile()],
      workspaceDir: "/tmp",
    });

    expect(updated).toHaveLength(2);
    expect(updated[1]?.path).toBe("/tmp/EXTRA.md");
  });
});
