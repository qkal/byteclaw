import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applySecurityFixConfigMutations,
  collectSecurityPermissionTargets,
  fixSecurityFootguns,
} from "./fix.js";

const isWindows = process.platform === "win32";

const expectPerms = (actual: number, expected: number) => {
  if (isWindows) {
    expect([expected, 0o666, 0o777]).toContain(actual);
    return;
  }
  expect(actual).toBe(expected);
};

describe("security fix", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createStateDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const createFixEnv = (stateDir: string, configPath: string) => ({
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  });

  const createWhatsAppConfigFixTestPlugin = (storeAllowFrom: string[]): ChannelPlugin => ({
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      inspectAccount: () => ({ accountId: "default", config: {}, configured: true, enabled: true }),
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default", config: {}, enabled: true }),
    },
    id: "whatsapp",
    meta: {
      blurb: "test stub",
      docsPath: "/docs/testing",
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
    },
    security: {
      applyConfigFixes: async ({ cfg }) => {
        if (storeAllowFrom.length === 0) {
          return { changes: [], config: cfg };
        }
        const next = structuredClone(cfg ?? {});
        const whatsapp = next.channels?.whatsapp as Record<string, unknown> | undefined;
        if (!whatsapp || typeof whatsapp !== "object") {
          return { changes: [], config: cfg };
        }
        const changes: string[] = [];
        let changed = false;
        const maybeApply = (prefix: string, holder: Record<string, unknown>) => {
          if (holder.groupPolicy !== "allowlist") {
            return;
          }
          const allowFrom = Array.isArray(holder.allowFrom) ? holder.allowFrom : [];
          const groupAllowFrom = Array.isArray(holder.groupAllowFrom) ? holder.groupAllowFrom : [];
          if (allowFrom.length > 0 || groupAllowFrom.length > 0) {
            return;
          }
          holder.groupAllowFrom = [...storeAllowFrom];
          changes.push(`${prefix}groupAllowFrom=pairing-store`);
          changed = true;
        };

        maybeApply("channels.whatsapp.", whatsapp);
        const { accounts } = whatsapp;
        if (accounts && typeof accounts === "object") {
          for (const [accountId, value] of Object.entries(accounts)) {
            if (!value || typeof value !== "object") {
              continue;
            }
            maybeApply(
              `channels.whatsapp.accounts.${accountId}.`,
              value as Record<string, unknown>,
            );
          }
        }

        return { changes, config: changed ? next : cfg };
      },
    },
  });

  const expectTightenedStateAndConfigPerms = async (stateDir: string, configPath: string) => {
    const stateMode = (await fs.stat(stateDir)).mode & 0o777;
    expectPerms(stateMode, 0o700);

    const configMode = (await fs.stat(configPath)).mode & 0o777;
    expectPerms(configMode, 0o600);
  };

  const expectWhatsAppGroupPolicy = (
    channels: Record<string, Record<string, unknown>>,
    expectedPolicy = "allowlist",
  ) => {
    expect(channels.whatsapp.groupPolicy).toBe(expectedPolicy);
  };

  const expectWhatsAppAccountGroupPolicy = (
    channels: Record<string, Record<string, unknown>>,
    accountId: string,
    expectedPolicy = "allowlist",
  ) => {
    const { whatsapp } = channels;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(accounts[accountId]?.groupPolicy).toBe(expectedPolicy);
    return accounts;
  };

  const fixWhatsAppConfigScenario = async (params: {
    whatsapp: Record<string, unknown>;
    allowFromStore: string[];
  }) => {
    const fixed = await applySecurityFixConfigMutations({
      cfg: {
        channels: {
          whatsapp: params.whatsapp,
        },
      } satisfies OpenClawConfig,
      channelPlugins: [createWhatsAppConfigFixTestPlugin(params.allowFromStore)],
      env: process.env,
    });
    return {
      channels: fixed.cfg.channels as Record<string, Record<string, unknown>>,
      res: { changes: fixed.changes, ok: true },
    };
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-fix-suite-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("tightens groupPolicy + filesystem perms", async () => {
    const cfg = {
      channels: {
        discord: { groupPolicy: "open" },
        imessage: { groupPolicy: "open" },
        signal: { groupPolicy: "open" },
        telegram: { groupPolicy: "open" },
        whatsapp: { groupPolicy: "open" },
      },
      logging: { redactSensitive: "off" },
    } satisfies OpenClawConfig;
    const fixed = await applySecurityFixConfigMutations({
      cfg,
      channelPlugins: [createWhatsAppConfigFixTestPlugin(["+15551234567"])],
      env: process.env,
    });
    expect(fixed.changes).toEqual(
      expect.arrayContaining([
        "channels.telegram.groupPolicy=open -> allowlist",
        "channels.whatsapp.groupPolicy=open -> allowlist",
        "channels.discord.groupPolicy=open -> allowlist",
        "channels.signal.groupPolicy=open -> allowlist",
        "channels.imessage.groupPolicy=open -> allowlist",
        'logging.redactSensitive=off -> "tools"',
      ]),
    );

    const channels = fixed.cfg.channels as Record<string, Record<string, unknown>>;
    expect(channels.telegram.groupPolicy).toBe("allowlist");
    expect(channels.whatsapp.groupPolicy).toBe("allowlist");
    expect(channels.discord.groupPolicy).toBe("allowlist");
    expect(channels.signal.groupPolicy).toBe("allowlist");
    expect(channels.imessage.groupPolicy).toBe("allowlist");

    expect(channels.whatsapp.groupAllowFrom).toEqual(["+15551234567"]);
  });

  it("applies allowlist per-account and seeds WhatsApp groupAllowFrom from store", async () => {
    const { res, channels } = await fixWhatsAppConfigScenario({
      allowFromStore: ["+15550001111"],
      whatsapp: {
        accounts: {
          a1: { groupPolicy: "open" },
        },
      },
    });
    expect(res.ok).toBe(true);
    const accounts = expectWhatsAppAccountGroupPolicy(channels, "a1");
    expect(accounts.a1.groupAllowFrom).toEqual(["+15550001111"]);
  });

  it("does not seed WhatsApp groupAllowFrom if allowFrom is set", async () => {
    const { res, channels } = await fixWhatsAppConfigScenario({
      allowFromStore: ["+15550001111"],
      whatsapp: {
        allowFrom: ["+15552223333"],
        groupPolicy: "open",
      },
    });
    expect(res.ok).toBe(true);
    expectWhatsAppGroupPolicy(channels);
    expect(channels.whatsapp.groupAllowFrom).toBeUndefined();
  });

  it("returns ok=false for invalid config but still tightens perms", async () => {
    const stateDir = await createStateDir("invalid-config");
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{ this is not json }\n", "utf8");
    await fs.chmod(configPath, 0o644);

    const env = createFixEnv(stateDir, configPath);

    const res = await fixSecurityFootguns({ configPath, env, stateDir });
    expect(res.ok).toBe(false);

    await expectTightenedStateAndConfigPerms(stateDir, configPath);
  });

  it("collects permission targets for credentials + agent auth/sessions + include files", async () => {
    const stateDir = await createStateDir("includes");

    const includesDir = path.join(stateDir, "includes");
    await fs.mkdir(includesDir, { recursive: true });
    const includePath = path.join(includesDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf8");
    await fs.chmod(includePath, 0o644);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{ "$include": "./includes/extra.json5", channels: { whatsapp: { groupPolicy: "open" } } }\n`,
      "utf8",
    );
    await fs.chmod(configPath, 0o644);

    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    const allowFromPath = path.join(credsDir, "whatsapp-allowFrom.json");
    await fs.writeFile(
      allowFromPath,
      `${JSON.stringify({ allowFrom: ["+15550002222"], version: 1 }, null, 2)}\n`,
      "utf8",
    );
    await fs.chmod(allowFromPath, 0o644);

    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const authProfilesPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(authProfilesPath, "{}\n", "utf8");
    await fs.chmod(authProfilesPath, 0o644);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionsStorePath = path.join(sessionsDir, "sessions.json");
    await fs.writeFile(sessionsStorePath, "{}\n", "utf8");
    await fs.chmod(sessionsStorePath, 0o644);
    const transcriptPath = path.join(sessionsDir, "sess-main.jsonl");
    await fs.writeFile(transcriptPath, '{"type":"session"}\n', "utf8");
    await fs.chmod(transcriptPath, 0o644);

    const targets = await collectSecurityPermissionTargets({
      cfg: {
        channels: { whatsapp: { groupPolicy: "open" } },
      } as OpenClawConfig,
      configPath,
      env: createFixEnv(stateDir, configPath),
      includePaths: [includePath],
      stateDir,
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        { mode: 0o700, path: stateDir, require: "dir" },
        { mode: 0o600, path: configPath, require: "file" },
        { mode: 0o700, path: credsDir, require: "dir" },
        { mode: 0o600, path: allowFromPath, require: "file" },
        { mode: 0o600, path: authProfilesPath, require: "file" },
        { mode: 0o600, path: sessionsStorePath, require: "file" },
        { mode: 0o600, path: transcriptPath, require: "file" },
        { mode: 0o600, path: includePath, require: "file" },
      ]),
    );
  });
});
