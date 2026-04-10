import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const configMocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn().mockResolvedValue(undefined);
  return {
    readConfigFileSnapshot: vi.fn(),
    replaceConfigFile: vi.fn(async (params: { nextConfig: unknown }) => {
      await writeConfigFile(params.nextConfig);
    }),
    writeConfigFile,
  };
});

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  replaceConfigFile: configMocks.replaceConfigFile,
  writeConfigFile: configMocks.writeConfigFile,
}));

import { agentsSetIdentityCommand } from "./agents.js";

const runtime = createTestRuntime();
interface ConfigWritePayload {
  agents?: { list?: { id: string; identity?: Record<string, string> }[] };
}

async function createIdentityWorkspace(subdir = "work") {
  const root = await makeTempWorkspace("openclaw-identity-");
  const workspace = path.join(root, subdir);
  await fs.mkdir(workspace, { recursive: true });
  return { root, workspace };
}

async function writeIdentityFile(workspace: string, lines: string[]) {
  const identityPath = path.join(workspace, "IDENTITY.md");
  await fs.writeFile(identityPath, `${lines.join("\n")}\n`, "utf8");
  return identityPath;
}

function getWrittenMainIdentity() {
  const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as ConfigWritePayload;
  return written.agents?.list?.find((entry) => entry.id === "main")?.identity;
}

async function runIdentityCommandFromWorkspace(workspace: string, fromIdentity = true) {
  configMocks.readConfigFileSnapshot.mockResolvedValue({
    ...baseConfigSnapshot,
    config: { agents: { list: [{ id: "main", workspace }] } },
  });
  await agentsSetIdentityCommand({ fromIdentity, workspace }, runtime);
}

describe("agents set-identity command", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    configMocks.replaceConfigFile.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("sets identity from workspace IDENTITY.md", async () => {
    const { root, workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, [
      "- Name: OpenClaw",
      "- Creature: helpful sloth",
      "- Emoji: :)",
      "- Avatar: avatars/openclaw.png",
      "",
    ]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          list: [
            { id: "main", workspace },
            { id: "ops", workspace: path.join(root, "ops") },
          ],
        },
      },
    });

    await agentsSetIdentityCommand({ workspace }, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(getWrittenMainIdentity()).toEqual({
      avatar: "avatars/openclaw.png",
      emoji: ":)",
      name: "OpenClaw",
      theme: "helpful sloth",
    });
  });

  it("errors when multiple agents match the same workspace", async () => {
    const { workspace } = await createIdentityWorkspace("shared");
    await writeIdentityFile(workspace, ["- Name: Echo"]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          list: [
            { id: "main", workspace },
            { id: "ops", workspace },
          ],
        },
      },
    });

    await agentsSetIdentityCommand({ workspace }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Multiple agents match"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("overrides identity file values with explicit flags", async () => {
    const { workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, [
      "- Name: OpenClaw",
      "- Theme: space lobster",
      "- Emoji: :)",
      "- Avatar: avatars/openclaw.png",
      "",
    ]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { list: [{ id: "main", workspace }] } },
    });

    await agentsSetIdentityCommand(
      {
        avatar: "https://example.com/override.png",
        emoji: "🦞",
        fromIdentity: true,
        name: "Nova",
        workspace,
      },
      runtime,
    );

    expect(getWrittenMainIdentity()).toEqual({
      avatar: "https://example.com/override.png",
      emoji: "🦞",
      name: "Nova",
      theme: "space lobster",
    });
  });

  it("reads identity from an explicit IDENTITY.md path", async () => {
    const { workspace } = await createIdentityWorkspace();
    const identityPath = await writeIdentityFile(workspace, [
      "- **Name:** C-3PO",
      "- **Creature:** Flustered Protocol Droid",
      "- **Emoji:** 🤖",
      "- **Avatar:** avatars/c3po.png",
      "",
    ]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { list: [{ id: "main" }] } },
    });

    await agentsSetIdentityCommand({ agent: "main", identityFile: identityPath }, runtime);

    expect(getWrittenMainIdentity()).toEqual({
      avatar: "avatars/c3po.png",
      emoji: "🤖",
      name: "C-3PO",
      theme: "Flustered Protocol Droid",
    });
  });

  it("accepts avatar-only identity from IDENTITY.md", async () => {
    const { workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, ["- Avatar: avatars/only.png"]);

    await runIdentityCommandFromWorkspace(workspace);

    expect(getWrittenMainIdentity()).toEqual({
      avatar: "avatars/only.png",
    });
  });

  it("accepts avatar-only updates via flags", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { list: [{ id: "main" }] } },
    });

    await agentsSetIdentityCommand(
      { agent: "main", avatar: "https://example.com/avatar.png" },
      runtime,
    );

    expect(getWrittenMainIdentity()).toEqual({
      avatar: "https://example.com/avatar.png",
    });
  });

  it("errors when identity data is missing", async () => {
    const { workspace } = await createIdentityWorkspace();

    await runIdentityCommandFromWorkspace(workspace);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("No identity data found"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
