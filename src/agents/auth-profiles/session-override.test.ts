import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

async function writeAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    order: {
      zai: ["zai:work"],
    },
    profiles: {
      "zai:work": { key: "sk-test", provider: "zai", type: "api_key" },
    },
    version: 1,
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf8");
}

async function writeAuthStoreWithProfiles(
  agentDir: string,
  params: {
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
    order?: Record<string, string[]>;
  },
) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  await fs.writeFile(
    authPath,
    JSON.stringify(
      {
        profiles: params.profiles,
        version: 1,
        ...(params.order ? { order: params.order } : {}),
      },
      null,
      2,
    ),
    "utf8",
  );
}

const TEST_PRIMARY_PROFILE_ID = "openai-codex:primary@example.test";
const TEST_SECONDARY_PROFILE_ID = "openai-codex:secondary@example.test";

describe("resolveSessionAuthProfileOverride", () => {
  it("returns early when no auth sources exist", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        agentDir,
        cfg: {} as OpenClawConfig,
        isNewSession: false,
        provider: "openrouter",
        sessionEntry,
        sessionKey: "agent:main:main",
        sessionStore,
        storePath: undefined,
      });

      expect(resolved).toBeUndefined();
      await expect(fs.access(path.join(agentDir, "auth-profiles.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps user override when provider alias differs", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        agentDir,
        cfg: {} as OpenClawConfig,
        isNewSession: false,
        provider: "z.ai",
        sessionEntry,
        sessionKey: "agent:main:main",
        sessionStore,
        storePath: undefined,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });

  it("keeps explicit user override when stored order prefers another profile", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStoreWithProfiles(agentDir, {
        order: {
          "openai-codex": [TEST_PRIMARY_PROFILE_ID],
        },
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            key: "sk-josh",
            provider: "openai-codex",
            type: "api_key",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            key: "sk-claude",
            provider: "openai-codex",
            type: "api_key",
          },
        },
      });

      const sessionEntry: SessionEntry = {
        authProfileOverride: TEST_SECONDARY_PROFILE_ID,
        authProfileOverrideSource: "user",
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        agentDir,
        cfg: {} as OpenClawConfig,
        isNewSession: false,
        provider: "openai-codex",
        sessionEntry,
        sessionKey: "agent:main:main",
        sessionStore,
        storePath: undefined,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });
});
