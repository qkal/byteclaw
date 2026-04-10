import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel,
} from "./model-picker-preferences.js";

const tempDirs: string[] = [];

async function createStateEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-picker-"));
  tempDirs.push(dir);
  return { ...process.env, OPENCLAW_STATE_DIR: dir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { force: true, recursive: true });
    }),
  );
});

describe("discord model picker preferences", () => {
  it("records recent models in recency order without duplicates", async () => {
    const env = await createStateEnv();
    const scope = { userId: "123" };

    await recordDiscordModelPickerRecentModel({ env, modelRef: "openai/gpt-4o", scope });
    await recordDiscordModelPickerRecentModel({ env, modelRef: "openai/gpt-4.1", scope });
    await recordDiscordModelPickerRecentModel({ env, modelRef: "openai/gpt-4o", scope });

    const recent = await readDiscordModelPickerRecentModels({ env, scope });
    expect(recent).toEqual(["openai/gpt-4o", "openai/gpt-4.1"]);
  });

  it("filters recent models using an allowlist", async () => {
    const env = await createStateEnv();
    const scope = { userId: "456" };

    await recordDiscordModelPickerRecentModel({ env, modelRef: "openai/gpt-4o", scope });
    await recordDiscordModelPickerRecentModel({ env, modelRef: "openai/gpt-4.1", scope });

    const recent = await readDiscordModelPickerRecentModels({
      allowedModelRefs: new Set(["openai/gpt-4.1"]),
      env,
      scope,
    });
    expect(recent).toEqual(["openai/gpt-4.1"]);
  });

  it("falls back to an empty store when the file is corrupt", async () => {
    const env = await createStateEnv();
    const stateDir = env.OPENCLAW_STATE_DIR as string;
    const filePath = path.join(stateDir, "discord", "model-picker-preferences.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not-json", "utf8");

    const recent = await readDiscordModelPickerRecentModels({
      env,
      scope: { userId: "789" },
    });
    expect(recent).toEqual([]);
  });
});
