import { afterEach, describe, expect, it } from "vitest";
import { loadEnabledClaudeBundleCommands } from "./bundle-commands.js";
import {
  createBundleMcpTempHarness,
  createEnabledPluginEntries,
  withBundleHomeEnv,
  writeBundleTextFiles,
  writeClaudeBundleManifest,
} from "./bundle-mcp.test-support.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

async function writeClaudeBundleCommandFixture(params: {
  homeDir: string;
  pluginId: string;
  commands: { relativePath: string; contents: string[] }[];
}) {
  const pluginRoot = await writeClaudeBundleManifest({
    homeDir: params.homeDir,
    manifest: { name: params.pluginId },
    pluginId: params.pluginId,
  });
  await writeBundleTextFiles(
    pluginRoot,
    Object.fromEntries(
      params.commands.map((command) => [
        command.relativePath,
        [...command.contents, ""].join("\n"),
      ]),
    ),
  );
}

function expectEnabledClaudeBundleCommands(
  commands: ReturnType<typeof loadEnabledClaudeBundleCommands>,
  expected: {
    pluginId: string;
    rawName: string;
    description: string;
    promptTemplate: string;
  }[],
) {
  expect(commands).toEqual(
    expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))),
  );
}

describe("loadEnabledClaudeBundleCommands", () => {
  it("loads enabled Claude bundle markdown commands and skips disabled-model-invocation entries", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-commands",
      async ({ homeDir, workspaceDir }) => {
        await writeClaudeBundleCommandFixture({
          commands: [
            {
              contents: [
                "---",
                "description: Help with scoping and architecture",
                "---",
                "Give direct engineering advice.",
              ],
              relativePath: "commands/office-hours.md",
            },
            {
              contents: [
                "---",
                "name: workflows:review",
                "description: Run a structured review",
                "---",
                "Review the code. $ARGUMENTS",
              ],
              relativePath: "commands/workflows/review.md",
            },
            {
              contents: ["---", "disable-model-invocation: true", "---", "Do not load me."],
              relativePath: "commands/disabled.md",
            },
          ],
          homeDir,
          pluginId: "compound-bundle",
        });

        const commands = loadEnabledClaudeBundleCommands({
          cfg: {
            plugins: {
              entries: createEnabledPluginEntries(["compound-bundle"]),
            },
          },
          workspaceDir,
        });

        expectEnabledClaudeBundleCommands(commands, [
          {
            description: "Help with scoping and architecture",
            pluginId: "compound-bundle",
            promptTemplate: "Give direct engineering advice.",
            rawName: "office-hours",
          },
          {
            description: "Run a structured review",
            pluginId: "compound-bundle",
            promptTemplate: "Review the code. $ARGUMENTS",
            rawName: "workflows:review",
          },
        ]);
        expect(commands.some((entry) => entry.rawName === "disabled")).toBe(false);
      },
    );
  });
});
