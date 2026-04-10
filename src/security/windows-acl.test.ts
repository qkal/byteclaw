import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowsAclEntry, WindowsAclSummary } from "./windows-acl.js";

const MOCK_USERNAME = "MockUser";
const userInfoMock = vi.hoisted(() =>
  vi.fn(() => ({
    gid: -1,
    homedir: "C:\\Users\\MockUser",
    shell: "C:\\Windows\\System32\\cmd.exe",
    uid: -1,
    username: MOCK_USERNAME,
  })),
);

vi.mock("node:os", async () => {
  const { mockNodeBuiltinModule } = await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:os")>("node:os"),
    { userInfo: userInfoMock as unknown as typeof import("node:os").userInfo },
    { mirrorToDefault: true },
  );
});

let createIcaclsResetCommand: typeof import("./windows-acl.js").createIcaclsResetCommand;
let formatIcaclsResetCommand: typeof import("./windows-acl.js").formatIcaclsResetCommand;
let formatWindowsAclSummary: typeof import("./windows-acl.js").formatWindowsAclSummary;
let inspectWindowsAcl: typeof import("./windows-acl.js").inspectWindowsAcl;
let parseIcaclsOutput: typeof import("./windows-acl.js").parseIcaclsOutput;
let resolveWindowsUserPrincipal: typeof import("./windows-acl.js").resolveWindowsUserPrincipal;
let summarizeWindowsAcl: typeof import("./windows-acl.js").summarizeWindowsAcl;

beforeAll(async () => {
  ({
    createIcaclsResetCommand,
    formatIcaclsResetCommand,
    formatWindowsAclSummary,
    inspectWindowsAcl,
    parseIcaclsOutput,
    resolveWindowsUserPrincipal,
    summarizeWindowsAcl,
  } = await import("./windows-acl.js"));
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

function aclEntry(params: {
  principal: string;
  rights?: string[];
  rawRights?: string;
  canRead?: boolean;
  canWrite?: boolean;
}): WindowsAclEntry {
  return {
    canRead: params.canRead ?? true,
    canWrite: params.canWrite ?? true,
    principal: params.principal,
    rawRights: params.rawRights ?? "(F)",
    rights: params.rights ?? ["F"],
  };
}

function expectSinglePrincipal(entries: WindowsAclEntry[], principal: string): void {
  expect(entries).toHaveLength(1);
  expect(entries[0].principal).toBe(principal);
}

function expectAccessRights(
  rights: string,
  expected: { canWrite: boolean; canRead: boolean },
): void {
  const output = `C:\\test\\file.txt BUILTIN\\Users:${rights}`;
  const entries = parseIcaclsOutput(output, String.raw`C:\test\file.txt`);
  expect(entries[0].canWrite, rights).toBe(expected.canWrite);
  expect(entries[0].canRead, rights).toBe(expected.canRead);
}

function expectTrustedOnly(
  entries: WindowsAclEntry[],
  options?: { env?: NodeJS.ProcessEnv; expectedTrusted?: number },
): void {
  const summary = summarizeWindowsAcl(entries, options?.env);
  expect(summary.trusted).toHaveLength(options?.expectedTrusted ?? 1);
  expect(summary.untrustedWorld).toHaveLength(0);
  expect(summary.untrustedGroup).toHaveLength(0);
}

function expectInspectSuccess(
  result: Awaited<ReturnType<typeof inspectWindowsAcl>>,
  expectedEntries: number,
): void {
  expect(result.ok).toBe(true);
  expect(result.entries).toHaveLength(expectedEntries);
}

function expectSummaryCounts(
  entries: readonly WindowsAclEntry[],
  expected: { trusted?: number; untrustedWorld?: number; untrustedGroup?: number },
  env?: NodeJS.ProcessEnv,
): void {
  const summary = summarizeWindowsAcl([...entries], env);
  expect(summary.trusted).toHaveLength(expected.trusted ?? 0);
  expect(summary.untrustedWorld).toHaveLength(expected.untrustedWorld ?? 0);
  expect(summary.untrustedGroup).toHaveLength(expected.untrustedGroup ?? 0);
}

describe("windows-acl", () => {
  describe("resolveWindowsUserPrincipal", () => {
    it(String.raw`returns DOMAIN\USERNAME when both are present`, () => {
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "TestUser" };
      expect(resolveWindowsUserPrincipal(env)).toBe(String.raw`WORKGROUP\TestUser`);
    });

    it("returns just USERNAME when USERDOMAIN is not present", () => {
      const env = { USERNAME: "TestUser" };
      expect(resolveWindowsUserPrincipal(env)).toBe("TestUser");
    });

    it("trims whitespace from values", () => {
      const env = { USERDOMAIN: "  WORKGROUP  ", USERNAME: "  TestUser  " };
      expect(resolveWindowsUserPrincipal(env)).toBe(String.raw`WORKGROUP\TestUser`);
    });

    it("falls back to os.userInfo when USERNAME is empty", () => {
      // When USERNAME env is empty, falls back to os.userInfo().username
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "" };
      const result = resolveWindowsUserPrincipal(env);
      // Should return a username (from os.userInfo fallback) with WORKGROUP domain
      expect(result).toBe(`WORKGROUP\\${MOCK_USERNAME}`);
    });
  });

  describe("parseIcaclsOutput", () => {
    it("parses standard icacls output", () => {
      const output = `C:\\test\\file.txt BUILTIN\\Administrators:(F)
                     NT AUTHORITY\\SYSTEM:(F)
                     WORKGROUP\\TestUser:(R)

Successfully processed 1 files`;
      const entries = parseIcaclsOutput(output, String.raw`C:\test\file.txt`);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({
        canRead: true,
        canWrite: true,
        principal: "BUILTIN\\Administrators",
        rawRights: "(F)",
        rights: ["F"],
      });
    });

    it("parses entries with inheritance flags", () => {
      const output = `C:\\test\\dir BUILTIN\\Users:(OI)(CI)(R)`;
      const entries = parseIcaclsOutput(output, String.raw`C:\test\dir`);
      expect(entries).toHaveLength(1);
      expect(entries[0].rights).toEqual(["R"]);
      expect(entries[0].canRead).toBe(true);
      expect(entries[0].canWrite).toBe(false);
    });

    it("filters out DENY entries", () => {
      const output = `C:\\test\\file.txt BUILTIN\\Users:(DENY)(W)
                     BUILTIN\\Administrators:(F)`;
      const entries = parseIcaclsOutput(output, String.raw`C:\test\file.txt`);
      expectSinglePrincipal(entries, String.raw`BUILTIN\Administrators`);
    });

    it("skips status messages", () => {
      const output = `Successfully processed 1 files
                     Processed file: C:\\test\\file.txt
                     Failed processing 0 files
                     No mapping between account names`;
      const entries = parseIcaclsOutput(output, String.raw`C:\test\file.txt`);
      expect(entries).toHaveLength(0);
    });

    it("skips localized (non-English) status lines that have no parenthesised token", () => {
      const output =
        "C:\\Users\\karte\\.openclaw NT AUTHORITY\\\u0421\u0418\u0421\u0422\u0415\u041c\u0410:(OI)(CI)(F)\n" +
        "\u0423\u0441\u043f\u0435\u0448\u043d\u043e \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u043d\u043e 1 \u0444\u0430\u0439\u043b\u043e\u0432; " +
        "\u043d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c 0 \u0444\u0430\u0439\u043b\u043e\u0432";
      const entries = parseIcaclsOutput(output, String.raw`C:\Users\karte\.openclaw`);
      expect(entries).toHaveLength(1);
      expect(entries[0].principal).toBe("NT AUTHORITY\\\u0421\u0418\u0421\u0422\u0415\u041c\u0410");
    });

    it("parses SID-format principals", () => {
      const output =
        "C:\\test\\file.txt S-1-5-18:(F)\n" +
        "                  S-1-5-21-1824257776-4070701511-781240313-1001:(F)";
      const entries = parseIcaclsOutput(output, String.raw`C:\test\file.txt`);
      expect(entries).toHaveLength(2);
      expect(entries[0].principal).toBe("S-1-5-18");
      expect(entries[1].principal).toBe("S-1-5-21-1824257776-4070701511-781240313-1001");
    });

    it("ignores malformed ACL lines that contain ':' but no rights tokens", () => {
      const output = `C:\\test\\file.txt random:message
                     C:\\test\\file.txt BUILTIN\\Administrators:(F)`;
      const entries = parseIcaclsOutput(output, String.raw`C:\test\file.txt`);
      expectSinglePrincipal(entries, String.raw`BUILTIN\Administrators`);
    });

    it("handles quoted target paths", () => {
      const output = `"C:\\path with spaces\\file.txt" BUILTIN\\Administrators:(F)`;
      const entries = parseIcaclsOutput(output, String.raw`C:\path with spaces\file.txt`);
      expect(entries).toHaveLength(1);
    });

    it.each([
      { canRead: true, canWrite: true, rights: "(F)" },
      { canRead: true, canWrite: true, rights: "(M)" },
      { canRead: false, canWrite: true, rights: "(W)" },
      { canRead: false, canWrite: true, rights: "(D)" },
      { canRead: true, canWrite: false, rights: "(R)" },
      { canRead: true, canWrite: false, rights: "(RX)" },
    ] as const)("detects write permissions correctly for %s", ({ rights, canWrite, canRead }) => {
      // F = Full control (read + write)
      // M = Modify (read + write)
      // W = Write
      // D = Delete (considered write)
      // R = Read only
      expectAccessRights(rights, { canRead, canWrite });
    });
  });

  describe("summarizeWindowsAcl", () => {
    it("classifies trusted principals", () => {
      const entries: WindowsAclEntry[] = [
        aclEntry({ principal: "NT AUTHORITY\\SYSTEM" }),
        aclEntry({ principal: "BUILTIN\\Administrators" }),
      ];
      const summary = summarizeWindowsAcl(entries);
      expect(summary.trusted).toHaveLength(2);
      expect(summary.untrustedWorld).toHaveLength(0);
      expect(summary.untrustedGroup).toHaveLength(0);
    });

    it("classifies world principals", () => {
      const entries: WindowsAclEntry[] = [
        aclEntry({
          canWrite: false,
          principal: "Everyone",
          rawRights: "(R)",
          rights: ["R"],
        }),
        aclEntry({
          canWrite: false,
          principal: "BUILTIN\\Users",
          rawRights: "(R)",
          rights: ["R"],
        }),
      ];
      const summary = summarizeWindowsAcl(entries);
      expect(summary.trusted).toHaveLength(0);
      expect(summary.untrustedWorld).toHaveLength(2);
      expect(summary.untrustedGroup).toHaveLength(0);
    });

    it("classifies current user as trusted", () => {
      const entries: WindowsAclEntry[] = [aclEntry({ principal: "WORKGROUP\\TestUser" })];
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "TestUser" };
      const summary = summarizeWindowsAcl(entries, env);
      expect(summary.trusted).toHaveLength(1);
    });

    it("classifies unknown principals as group", () => {
      const entries: WindowsAclEntry[] = [
        {
          canRead: true,
          canWrite: false,
          principal: "DOMAIN\\SomeOtherUser",
          rawRights: "(R)",
          rights: ["R"],
        },
      ];
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "TestUser" };
      const summary = summarizeWindowsAcl(entries, env);
      expect(summary.untrustedGroup).toHaveLength(1);
    });
  });

  describe("summarizeWindowsAcl — SID-based classification", () => {
    it.each([
      {
        entries: [aclEntry({ principal: "S-1-5-18" })],
        expected: { trusted: 1 },
        name: "SYSTEM SID (S-1-5-18) is trusted",
      },
      {
        name: "*S-1-5-18 (icacls /sid SYSTEM) is trusted",
        // Icacls /sid output prefixes SIDs with *.
        entries: [aclEntry({ principal: "*S-1-5-18" })],
        expected: { trusted: 1 },
      },
      {
        entries: [aclEntry({ principal: "*S-1-5-32-544" })],
        expected: { trusted: 1 },
        name: "*S-1-5-32-544 (icacls /sid Administrators) is trusted",
      },
      {
        entries: [aclEntry({ principal: "S-1-5-32-544" })],
        expected: { trusted: 1 },
        name: "BUILTIN\\\\Administrators SID (S-1-5-32-544) is trusted",
      },
      {
        entries: [aclEntry({ principal: "S-1-5-21-1824257776-4070701511-781240313-1001" })],
        env: { USERSID: "S-1-5-21-1824257776-4070701511-781240313-1001" },
        expected: { trusted: 1 },
        name: "caller SID from USERSID env var is trusted",
      },
      {
        entries: [aclEntry({ principal: "s-1-5-21-1824257776-4070701511-781240313-1001" })],
        env: { USERSID: "  S-1-5-21-1824257776-4070701511-781240313-1001  " },
        expected: { trusted: 1 },
        name: "SIDs match case-insensitively and trim USERSID",
      },
      {
        entries: [
          aclEntry({
            canRead: true,
            canWrite: false,
            principal: "*S-1-1-0",
            rawRights: "(R)",
            rights: ["R"],
          }),
        ],
        env: { USERSID: "*S-1-1-0" },
        expected: { untrustedWorld: 1 },
        name: "does not trust *-prefixed Everyone via USERSID",
      },
      {
        entries: [
          aclEntry({
            canRead: true,
            canWrite: false,
            principal: "S-1-5-21-9999-9999-9999-500",
            rawRights: "(R)",
            rights: ["R"],
          }),
        ],
        expected: { untrustedGroup: 1 },
        name: "unknown SID is group, not world",
      },
      {
        entries: [
          aclEntry({
            canRead: true,
            canWrite: false,
            principal: "*S-1-1-0",
            rawRights: "(R)",
            rights: ["R"],
          }),
        ],
        expected: { untrustedWorld: 1 },
        name: "Everyone SID (S-1-1-0) is world, not group",
      },
      {
        entries: [
          aclEntry({
            canRead: true,
            canWrite: false,
            principal: "*S-1-5-11",
            rawRights: "(R)",
            rights: ["R"],
          }),
        ],
        expected: { untrustedWorld: 1 },
        name: "Authenticated Users SID (S-1-5-11) is world, not group",
      },
      {
        entries: [
          aclEntry({
            canRead: true,
            canWrite: false,
            principal: "*S-1-5-32-545",
            rawRights: "(R)",
            rights: ["R"],
          }),
        ],
        expected: { untrustedWorld: 1 },
        name: "BUILTIN\\\\Users SID (S-1-5-32-545) is world, not group",
      },
    ] as const)("$name", ({ entries, env, expected }) => {
      expectSummaryCounts(entries, expected, env);
    });

    it("full scenario: SYSTEM SID + owner SID only → no findings", () => {
      const ownerSid = "S-1-5-21-1824257776-4070701511-781240313-1001";
      const entries: WindowsAclEntry[] = [
        {
          canRead: true,
          canWrite: true,
          principal: "S-1-5-18",
          rawRights: "(OI)(CI)(F)",
          rights: ["F"],
        },
        {
          canRead: true,
          canWrite: true,
          principal: ownerSid,
          rawRights: "(OI)(CI)(F)",
          rights: ["F"],
        },
      ];
      const env = { USERSID: ownerSid };
      const summary = summarizeWindowsAcl(entries, env);
      expect(summary.trusted).toHaveLength(2);
      expect(summary.untrustedWorld).toHaveLength(0);
      expect(summary.untrustedGroup).toHaveLength(0);
    });
  });

  describe("inspectWindowsAcl", () => {
    it("returns parsed ACL entries on success", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        stderr: "",
        stdout: `C:\\test\\file.txt BUILTIN\\Administrators:(F)
                NT AUTHORITY\\SYSTEM:(F)`,
      });

      const result = await inspectWindowsAcl(String.raw`C:\test\file.txt`, {
        exec: mockExec,
      });
      expectInspectSuccess(result, 2);
      // /sid is passed so that account names are printed as SIDs, making the
      // Audit locale-independent (fixes #35834).
      expect(mockExec).toHaveBeenCalledWith("icacls", [String.raw`C:\test\file.txt`, "/sid"]);
    });

    it("classifies *S-1-5-18 (SID form of SYSTEM from /sid) as trusted", async () => {
      // When icacls is called with /sid it outputs *S-X-X-X instead of
      // Locale-dependent names like "NT AUTHORITY\\SYSTEM" or the Russian
      // Garbled equivalent.
      const mockExec = vi.fn().mockResolvedValue({
        stderr: "",
        stdout:
          "C:\\test\\file.txt *S-1-5-21-111-222-333-1001:(F)\n                *S-1-5-18:(F)\n                *S-1-5-32-544:(F)",
      });

      const result = await inspectWindowsAcl(String.raw`C:\test\file.txt`, {
        env: { USERSID: "S-1-5-21-111-222-333-1001" },
        exec: mockExec,
      });
      expectInspectSuccess(result, 3);
      // All three entries (current user, SYSTEM, Administrators) must be trusted.
      expect(result.trusted).toHaveLength(3);
      expect(result.untrustedGroup).toHaveLength(0);
      expect(result.untrustedWorld).toHaveLength(0);
    });

    it("resolves current user SID via whoami when USERSID is missing", async () => {
      const mockExec = vi
        .fn()
        .mockResolvedValueOnce({
          stderr: "",
          stdout:
            "C:\\test\\file.txt *S-1-5-21-111-222-333-1001:(F)\n                *S-1-5-18:(F)",
        })
        .mockResolvedValueOnce({
          stderr: "",
          stdout: '"mock-host\\\\MockUser","S-1-5-21-111-222-333-1001"\r\n',
        });

      const result = await inspectWindowsAcl(String.raw`C:\test\file.txt`, {
        env: { USERDOMAIN: "mock-host", USERNAME: "MockUser" },
        exec: mockExec,
      });

      expectInspectSuccess(result, 2);
      expect(result.trusted).toHaveLength(2);
      expect(result.untrustedGroup).toHaveLength(0);
      expect(mockExec).toHaveBeenNthCalledWith(1, "icacls", [String.raw`C:\test\file.txt`, "/sid"]);
      expect(mockExec).toHaveBeenNthCalledWith(2, "whoami", ["/user", "/fo", "csv", "/nh"]);
    });

    it("returns error state on exec failure", async () => {
      const mockExec = vi.fn().mockRejectedValue(new Error("icacls not found"));

      const result = await inspectWindowsAcl(String.raw`C:\test\file.txt`, {
        exec: mockExec,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("icacls not found");
      expect(result.entries).toHaveLength(0);
    });

    it("combines stdout and stderr for parsing", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        stderr: "C:\\test\\file.txt NT AUTHORITY\\SYSTEM:(F)",
        stdout: "C:\\test\\file.txt BUILTIN\\Administrators:(F)",
      });

      const result = await inspectWindowsAcl(String.raw`C:\test\file.txt`, {
        exec: mockExec,
      });
      expectInspectSuccess(result, 2);
    });
  });

  describe("formatWindowsAclSummary", () => {
    it("returns 'unknown' for failed summary", () => {
      const summary: WindowsAclSummary = {
        entries: [],
        error: "icacls failed",
        ok: false,
        trusted: [],
        untrustedGroup: [],
        untrustedWorld: [],
      };
      expect(formatWindowsAclSummary(summary)).toBe("unknown");
    });

    it("returns 'trusted-only' when no untrusted entries", () => {
      const summary: WindowsAclSummary = {
        entries: [],
        ok: true,
        trusted: [
          {
            canRead: true,
            canWrite: true,
            principal: "BUILTIN\\Administrators",
            rawRights: "(F)",
            rights: ["F"],
          },
        ],
        untrustedGroup: [],
        untrustedWorld: [],
      };
      expect(formatWindowsAclSummary(summary)).toBe("trusted-only");
    });

    it("formats untrusted entries", () => {
      const summary: WindowsAclSummary = {
        entries: [],
        ok: true,
        trusted: [],
        untrustedGroup: [
          {
            canRead: true,
            canWrite: true,
            principal: "DOMAIN\\OtherUser",
            rawRights: "(M)",
            rights: ["M"],
          },
        ],
        untrustedWorld: [
          {
            canRead: true,
            canWrite: false,
            principal: "Everyone",
            rawRights: "(R)",
            rights: ["R"],
          },
        ],
      };
      const result = formatWindowsAclSummary(summary);
      expect(result).toBe(String.raw`Everyone:(R), DOMAIN\OtherUser:(M)`);
    });
  });

  describe("formatIcaclsResetCommand", () => {
    it("generates command for files", () => {
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "TestUser" };
      const result = formatIcaclsResetCommand(String.raw`C:\test\file.txt`, {
        env,
        isDir: false,
      });
      expect(result).toBe(
        String.raw`icacls "C:\test\file.txt" /inheritance:r /grant:r "WORKGROUP\TestUser:F" /grant:r "*S-1-5-18:F"`,
      );
    });

    it("generates command for directories with inheritance flags", () => {
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "TestUser" };
      const result = formatIcaclsResetCommand(String.raw`C:\test\dir`, {
        env,
        isDir: true,
      });
      expect(result).toContain("(OI)(CI)F");
    });

    it("uses system username when env is empty (falls back to os.userInfo)", () => {
      // When env is empty, resolveWindowsUserPrincipal falls back to os.userInfo().username
      const result = formatIcaclsResetCommand(String.raw`C:\test\file.txt`, {
        env: {},
        isDir: false,
      });
      // Should contain the actual system username from os.userInfo
      expect(result).toContain(`"${MOCK_USERNAME}:F"`);
      expect(result).not.toContain("%USERNAME%");
    });
  });

  describe("createIcaclsResetCommand", () => {
    it("returns structured command object", () => {
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "TestUser" };
      const result = createIcaclsResetCommand(String.raw`C:\test\file.txt`, {
        env,
        isDir: false,
      });
      expect(result).not.toBeNull();
      expect(result?.command).toBe("icacls");
      expect(result?.args).toContain(String.raw`C:\test\file.txt`);
      expect(result?.args).toContain("/inheritance:r");
    });

    it("returns command with system username when env is empty (falls back to os.userInfo)", () => {
      // When env is empty, resolveWindowsUserPrincipal falls back to os.userInfo().username
      const result = createIcaclsResetCommand(String.raw`C:\test\file.txt`, {
        env: {},
        isDir: false,
      });
      // Should return a valid command using the system username
      expect(result).not.toBeNull();
      expect(result?.command).toBe("icacls");
      expect(result?.args).toContain(`${MOCK_USERNAME}:F`);
    });

    it("includes display string matching formatIcaclsResetCommand", () => {
      const env = { USERDOMAIN: "WORKGROUP", USERNAME: "TestUser" };
      const result = createIcaclsResetCommand(String.raw`C:\test\file.txt`, {
        env,
        isDir: false,
      });
      const expected = formatIcaclsResetCommand(String.raw`C:\test\file.txt`, {
        env,
        isDir: false,
      });
      expect(result?.display).toBe(expected);
    });
  });

  describe("summarizeWindowsAcl — localized SYSTEM account names", () => {
    it(String.raw`classifies French SYSTEM (AUTORITE NT\Système) as trusted`, () => {
      expectTrustedOnly([aclEntry({ principal: "AUTORITE NT\\Système" })]);
    });

    it(String.raw`classifies German SYSTEM (NT-AUTORITÄT\SYSTEM) as trusted`, () => {
      expectTrustedOnly([aclEntry({ principal: "NT-AUTORITÄT\\SYSTEM" })]);
    });

    it(String.raw`classifies Spanish SYSTEM (AUTORIDAD NT\SYSTEM) as trusted`, () => {
      expectTrustedOnly([aclEntry({ principal: "AUTORIDAD NT\\SYSTEM" })]);
    });

    it("French Windows full scenario: user + Système only → no untrusted", () => {
      const entries: WindowsAclEntry[] = [
        aclEntry({ principal: "MYPC\\Pierre" }),
        aclEntry({ principal: "AUTORITE NT\\Système" }),
      ];
      const env = { USERDOMAIN: "MYPC", USERNAME: "Pierre" };
      const { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, env);
      expect(trusted).toHaveLength(2);
      expect(untrustedWorld).toHaveLength(0);
      expect(untrustedGroup).toHaveLength(0);
    });
  });

  describe("formatIcaclsResetCommand — uses SID for SYSTEM", () => {
    it("uses *S-1-5-18 instead of SYSTEM in reset command", () => {
      const cmd = formatIcaclsResetCommand(String.raw`C:\test.json`, {
        env: { USERDOMAIN: "PC", USERNAME: "TestUser" },
        isDir: false,
      });
      expect(cmd).toContain("*S-1-5-18:F");
      expect(cmd).not.toContain("SYSTEM:F");
    });
  });
});
