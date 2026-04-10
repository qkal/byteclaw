import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import { ensurePiAuthJsonFromAuthProfiles } from "./pi-auth-json.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

type AuthProfileStore = Parameters<typeof saveAuthProfileStore>[0];

async function createAgentDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
}

function writeProfiles(agentDir: string, profiles: AuthProfileStore["profiles"]) {
  saveAuthProfileStore(
    {
      profiles,
      version: 1,
    },
    agentDir,
  );
}

async function readAuthJson(agentDir: string) {
  const authPath = path.join(agentDir, "auth.json");
  return JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
}

describe("ensurePiAuthJsonFromAuthProfiles", () => {
  it("writes openai-codex oauth credentials into auth.json for pi-coding-agent discovery", async () => {
    const agentDir = await createAgentDir();

    writeProfiles(agentDir, {
      "openai-codex:default": {
        access: "access-token",
        expires: Date.now() + 60_000,
        provider: "openai-codex",
        refresh: "refresh-token",
        type: "oauth",
      },
    });

    const first = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(first.wrote).toBe(true);

    const auth = await readAuthJson(agentDir);
    expect(auth["openai-codex"]).toMatchObject({
      access: "access-token",
      refresh: "refresh-token",
      type: "oauth",
    });

    const second = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(second.wrote).toBe(false);
  });

  it("writes api_key credentials into auth.json", async () => {
    const agentDir = await createAgentDir();

    writeProfiles(agentDir, {
      "openrouter:default": {
        key: "sk-or-v1-test-key",
        provider: "openrouter",
        type: "api_key",
      },
    });

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const auth = await readAuthJson(agentDir);
    expect(auth["openrouter"]).toMatchObject({
      key: "sk-or-v1-test-key",
      type: "api_key",
    });
  });

  it("writes token credentials as api_key into auth.json", async () => {
    const agentDir = await createAgentDir();

    writeProfiles(agentDir, {
      "anthropic:default": {
        provider: "anthropic",
        token: "sk-ant-test-token",
        type: "token",
      },
    });

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const auth = await readAuthJson(agentDir);
    expect(auth["anthropic"]).toMatchObject({
      key: "sk-ant-test-token",
      type: "api_key",
    });
  });

  it("syncs multiple providers at once", async () => {
    const agentDir = await createAgentDir();

    writeProfiles(agentDir, {
      "anthropic:default": {
        provider: "anthropic",
        token: "sk-ant-token",
        type: "token",
      },
      "openai-codex:default": {
        access: "access",
        expires: Date.now() + 60_000,
        provider: "openai-codex",
        refresh: "refresh",
        type: "oauth",
      },
      "openrouter:default": {
        key: "sk-or-key",
        provider: "openrouter",
        type: "api_key",
      },
    });

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const auth = await readAuthJson(agentDir);

    expect(auth["openrouter"]).toMatchObject({ key: "sk-or-key", type: "api_key" });
    expect(auth["anthropic"]).toMatchObject({ key: "sk-ant-token", type: "api_key" });
    expect(auth["openai-codex"]).toMatchObject({ access: "access", type: "oauth" });
  });

  it("skips profiles with empty keys", async () => {
    const agentDir = await createAgentDir();

    writeProfiles(agentDir, {
      "openrouter:default": {
        key: "",
        provider: "openrouter",
        type: "api_key",
      },
    });

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(false);
  });

  it("skips expired token credentials", async () => {
    const agentDir = await createAgentDir();

    writeProfiles(agentDir, {
      "anthropic:default": {
        expires: Date.now() - 60_000,
        provider: "anthropic",
        token: "sk-ant-expired",
        type: "token",
      },
    });

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(false);
  });

  it("normalizes provider ids when writing auth.json keys", async () => {
    const agentDir = await createAgentDir();

    writeProfiles(agentDir, {
      "z.ai:default": {
        key: "sk-zai",
        provider: "z.ai",
        type: "api_key",
      },
    });

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const auth = await readAuthJson(agentDir);
    expect(auth["zai"]).toMatchObject({ key: "sk-zai", type: "api_key" });
    expect(auth["z.ai"]).toBeUndefined();
  });

  it("preserves existing auth.json entries not in auth-profiles", async () => {
    const agentDir = await createAgentDir();
    const authPath = path.join(agentDir, "auth.json");

    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({ "legacy-provider": { key: "legacy-key", type: "api_key" } }),
    );

    writeProfiles(agentDir, {
      "openrouter:default": {
        key: "new-key",
        provider: "openrouter",
        type: "api_key",
      },
    });

    await ensurePiAuthJsonFromAuthProfiles(agentDir);

    const auth = await readAuthJson(agentDir);
    expect(auth["legacy-provider"]).toMatchObject({ key: "legacy-key", type: "api_key" });
    expect(auth["openrouter"]).toMatchObject({ key: "new-key", type: "api_key" });
  });

  it("treats malformed existing provider entries as stale and replaces them", async () => {
    const agentDir = await createAgentDir();
    const authPath = path.join(agentDir, "auth.json");

    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(authPath, JSON.stringify({ openrouter: { key: 123, type: "api_key" } }));

    writeProfiles(agentDir, {
      "openrouter:default": {
        key: "new-key",
        provider: "openrouter",
        type: "api_key",
      },
    });

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const auth = await readAuthJson(agentDir);
    expect(auth["openrouter"]).toMatchObject({ key: "new-key", type: "api_key" });
  });
});
