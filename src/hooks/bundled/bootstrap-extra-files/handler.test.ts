import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function createBootstrapExtraConfig(paths: string[]): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": {
            enabled: true,
            paths,
          },
        },
      },
    },
  };
}

async function createBootstrapContext(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  rootFiles: { name: string; content: string }[];
}): Promise<AgentBootstrapHookContext> {
  const bootstrapFiles = (await Promise.all(
    params.rootFiles.map(async (file) => ({
      content: file.content,
      missing: false,
      name: file.name,
      path: await writeWorkspaceFile({
        content: file.content,
        dir: params.workspaceDir,
        name: file.name,
      }),
    })),
  )) as AgentBootstrapHookContext["bootstrapFiles"];
  return {
    bootstrapFiles,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  };
}

describe("bootstrap-extra-files hook", () => {
  it("appends extra bootstrap files from configured patterns", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf8");

    const cfg = createBootstrapExtraConfig(["packages/*/AGENTS.md"]);
    const context = await createBootstrapContext({
      cfg,
      rootFiles: [{ content: "root agents", name: "AGENTS.md" }],
      sessionKey: "agent:main:main",
      workspaceDir: tempDir,
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.filter((f) => f.name === "AGENTS.md");
    expect(injected).toHaveLength(2);
    expect(injected.some((f) => f.path.endsWith(path.join("packages", "core", "AGENTS.md")))).toBe(
      true,
    );
  });

  it("re-applies subagent bootstrap allowlist after extras are added", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-subagent-");
    const extraDir = path.join(tempDir, "packages", "persona");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "SOUL.md"), "evil", "utf8");

    const cfg = createBootstrapExtraConfig(["packages/*/SOUL.md"]);
    const context = await createBootstrapContext({
      cfg,
      rootFiles: [
        { content: "root agents", name: "AGENTS.md" },
        { content: "root tools", name: "TOOLS.md" },
      ],
      sessionKey: "agent:main:subagent:abc",
      workspaceDir: tempDir,
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);
    expect(context.bootstrapFiles.map((f) => f.name).toSorted()).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
    ]);
  });
});
