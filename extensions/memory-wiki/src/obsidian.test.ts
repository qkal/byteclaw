import { describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { runObsidianDaily, runObsidianSearch } from "./obsidian.js";

describe("runObsidianSearch", () => {
  it("builds the official obsidian cli argv with the configured vault name", async () => {
    const config = resolveMemoryWikiConfig(
      {
        obsidian: {
          enabled: true,
          useOfficialCli: true,
          vaultName: "OpenClaw Wiki",
        },
      },
      { homedir: "/Users/tester" },
    );
    const calls: { command: string; argv: string[] }[] = [];
    const execImpl = async (command: string, argv?: readonly string[] | null) => {
      calls.push({ argv: argv ? [...argv] : [], command });
      return { stderr: "", stdout: "search output\n" };
    };
    const exec = execImpl as unknown as NonNullable<
      NonNullable<Parameters<typeof runObsidianSearch>[0]["deps"]>["exec"]
    >;

    const result = await runObsidianSearch({
      config,
      deps: {
        exec,
        resolveCommand: async () => "/usr/local/bin/obsidian",
      },
      query: "agent memory",
    });

    expect(calls).toEqual([
      {
        argv: ["vault=OpenClaw Wiki", "search", "query=agent memory"],
        command: "/usr/local/bin/obsidian",
      },
    ]);
    expect(result.stdout).toBe("search output\n");
  });
});

describe("runObsidianDaily", () => {
  it("fails cleanly when the obsidian cli is not installed", async () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });

    await expect(
      runObsidianDaily({
        config,
        deps: {
          resolveCommand: async () => null,
        },
      }),
    ).rejects.toThrow("Obsidian CLI is not available on PATH.");
  });
});
