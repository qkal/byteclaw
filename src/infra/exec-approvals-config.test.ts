import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  type ExecAllowlistEntry,
  type ExecApprovalsAgent,
  type ExecApprovalsFile,
  isSafeBinUsage,
  matchAllowlist,
  normalizeExecApprovals,
  normalizeSafeBins,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
} from "./exec-approvals.js";

describe("exec approvals wildcard agent", () => {
  it("merges wildcard allowlist entries with agent entries", () => {
    const dir = makeTempDir();
    const prevOpenClawHome = process.env.OPENCLAW_HOME;

    try {
      process.env.OPENCLAW_HOME = dir;
      const approvalsPath = path.join(dir, ".openclaw", "exec-approvals.json");
      fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
      fs.writeFileSync(
        approvalsPath,
        JSON.stringify(
          {
            agents: {
              "*": { allowlist: [{ pattern: "/bin/hostname" }] },
              main: { allowlist: [{ pattern: "/usr/bin/uname" }] },
            },
            version: 1,
          },
          null,
          2,
        ),
      );

      const resolved = resolveExecApprovals("main");
      expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual([
        "/bin/hostname",
        "/usr/bin/uname",
      ]);
    } finally {
      if (prevOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = prevOpenClawHome;
      }
    }
  });
});

describe("exec approvals node host allowlist check", () => {
  // These tests verify the allowlist satisfaction logic used by the node host path
  // The node host checks: matchAllowlist() || isSafeBinUsage() for each command segment
  // Using hardcoded resolution objects for cross-platform compatibility

  it.each([
    {
      entries: [{ pattern: "/usr/bin/python3" }],
      expectedPattern: "/usr/bin/python3",
      resolution: {
        executableName: "python3",
        rawExecutable: "python3",
        resolvedPath: "/usr/bin/python3",
      },
    },
    {
      // Simulates symlink resolution:
      // /opt/homebrew/bin/python3 -> /opt/homebrew/opt/python@3.14/bin/python3.14
      entries: [{ pattern: "/opt/**/python*" }],
      expectedPattern: "/opt/**/python*",
      resolution: {
        executableName: "python3.14",
        rawExecutable: "python3",
        resolvedPath: "/opt/homebrew/opt/python@3.14/bin/python3.14",
      },
    },
    {
      entries: [{ pattern: "/usr/bin/python3" }, { pattern: "/opt/**/node" }],
      expectedPattern: null,
      resolution: {
        executableName: "unknown-tool",
        rawExecutable: "unknown-tool",
        resolvedPath: "/usr/local/bin/unknown-tool",
      },
    },
  ])(
    "matches exact and wildcard allowlist patterns for %j",
    ({ resolution, entries, expectedPattern }) => {
      const match = matchAllowlist(entries, resolution);
      expect(match?.pattern ?? null).toBe(expectedPattern);
    },
  );

  it("does not treat unknown tools as safe bins", () => {
    const resolution = {
      executableName: "unknown-tool",
      rawExecutable: "unknown-tool",
      resolvedPath: "/usr/local/bin/unknown-tool",
    };
    const safe = isSafeBinUsage({
      argv: ["unknown-tool", "--help"],
      resolution,
      safeBins: normalizeSafeBins(["jq", "curl"]),
    });
    expect(safe).toBe(false);
  });

  it("satisfies via safeBins even when not in allowlist", () => {
    const resolution = {
      executableName: "jq",
      rawExecutable: "jq",
      resolvedPath: "/usr/bin/jq",
    };
    // Not in allowlist
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/python3" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();

    // But is a safe bin with non-file args
    const safe = isSafeBinUsage({
      argv: ["jq", ".foo"],
      resolution,
      safeBins: normalizeSafeBins(["jq"]),
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(safe).toBe(false);
      return;
    }
    expect(safe).toBe(true);
  });
});

describe("exec approvals default agent migration", () => {
  it("migrates legacy default agent entries to main", () => {
    const file: ExecApprovalsFile = {
      agents: {
        default: { allowlist: [{ pattern: "/bin/legacy" }] },
      },
      version: 1,
    };
    const resolved = resolveExecApprovalsFromFile({ file });
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
    expect(resolved.file.agents?.main?.allowlist?.[0]?.pattern).toBe("/bin/legacy");
  });

  it("prefers main agent settings when both main and default exist", () => {
    const file: ExecApprovalsFile = {
      agents: {
        default: { allowlist: [{ pattern: "/bin/legacy" }], ask: "off" },
        main: { allowlist: [{ pattern: "/bin/main" }], ask: "always" },
      },
      version: 1,
    };
    const resolved = resolveExecApprovalsFromFile({ file });
    expect(resolved.agent.ask).toBe("always");
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/main", "/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
  });
});

describe("exec approvals invalid explicit policy fallback", () => {
  it("treats invalid explicit agent fields as masked and falls back to defaults instead of wildcard", () => {
    const resolved = resolveExecApprovalsFromFile({
      agentId: "runner",
      file: {
        agents: {
          "*": {
            ask: "always",
            askFallback: "full",
            security: "full",
          },
          runner: {
            ask: "Always" as unknown as ExecApprovalsAgent["ask"],
            askFallback: "bar" as unknown as ExecApprovalsAgent["askFallback"],
            security: "foo" as unknown as ExecApprovalsAgent["security"],
          },
        },
        defaults: {
          ask: "on-miss",
          askFallback: "deny",
          security: "deny",
        },
        version: 1,
      },
      overrides: {
        ask: "off",
        askFallback: "full",
        security: "full",
      },
    });

    expect(resolved.agent).toMatchObject({
      ask: "on-miss",
      askFallback: "deny",
      security: "deny",
    });
    expect(resolved.agentSources).toEqual({
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
      security: "defaults.security",
    });
  });

  it("treats null explicit agent fields as unset and still considers wildcard", () => {
    const resolved = resolveExecApprovalsFromFile({
      agentId: "runner",
      file: {
        agents: {
          "*": {
            ask: "always",
            askFallback: "deny",
            security: "deny",
          },
          runner: {
            ask: null as unknown as ExecApprovalsAgent["ask"],
            askFallback: null as unknown as ExecApprovalsAgent["askFallback"],
            security: null as unknown as ExecApprovalsAgent["security"],
          },
        },
        defaults: {
          ask: "off",
          askFallback: "full",
          security: "full",
        },
        version: 1,
      },
      overrides: {
        ask: "off",
        askFallback: "full",
        security: "full",
      },
    });

    expect(resolved.agent).toMatchObject({
      ask: "always",
      askFallback: "deny",
      security: "deny",
    });
    expect(resolved.agentSources).toEqual({
      ask: "agents.*.ask",
      askFallback: "agents.*.askFallback",
      security: "agents.*.security",
    });
  });
});

describe("normalizeExecApprovals handles string allowlist entries (#9790)", () => {
  function normalizeMainAllowlist(file: ExecApprovalsFile): ExecAllowlistEntry[] | undefined {
    const normalized = normalizeExecApprovals(file);
    return normalized.agents?.main?.allowlist;
  }

  function expectNoSpreadStringArtifacts(entries: ExecAllowlistEntry[]) {
    for (const entry of entries) {
      expect(entry).toHaveProperty("pattern");
      expect(typeof entry.pattern).toBe("string");
      expect(entry.pattern.length).toBeGreaterThan(0);
      expect(entry).not.toHaveProperty("0");
    }
  }

  it("converts bare string entries to proper ExecAllowlistEntry objects", () => {
    // Simulates a corrupted or legacy config where allowlist contains plain
    // Strings (e.g. ["ls", "cat"]) instead of { pattern: "..." } objects.
    const file = {
      agents: {
        main: {
          allowlist: ["things", "remindctl", "memo", "which", "ls", "cat", "echo"],
          mode: "allowlist",
        },
      },
      version: 1,
    } as unknown as ExecApprovalsFile;

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    // Spread-string corruption would create numeric keys — ensure none exist.
    expectNoSpreadStringArtifacts(entries);

    expect(entries.map((e) => e.pattern)).toEqual([
      "things",
      "remindctl",
      "memo",
      "which",
      "ls",
      "cat",
      "echo",
    ]);
  });

  it("preserves proper ExecAllowlistEntry objects unchanged", () => {
    const file: ExecApprovalsFile = {
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/ls" }, { id: "existing-id", pattern: "/usr/bin/cat" }],
        },
      },
      version: 1,
    };

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    expect(entries).toHaveLength(2);
    expect(entries[0]?.pattern).toBe("/usr/bin/ls");
    expect(entries[1]?.pattern).toBe("/usr/bin/cat");
    expect(entries[1]?.id).toBe("existing-id");
  });

  it.each([
    {
      allowlist: ["ls", { pattern: "/usr/bin/cat" }, "echo"],
      expectedPatterns: ["ls", "/usr/bin/cat", "echo"],
      name: "mixed entries",
    },
    {
      allowlist: ["", "  ", "ls"],
      expectedPatterns: ["ls"],
      name: "empty strings dropped",
    },
    {
      allowlist: [{ pattern: "/usr/bin/ls" }, {}, { pattern: 123 }, { pattern: "   " }, "echo"],
      expectedPatterns: ["/usr/bin/ls", "echo"],
      name: "malformed objects dropped",
    },
    {
      allowlist: "ls",
      expectedPatterns: undefined,
      name: "non-array dropped",
    },
  ] satisfies readonly {
    name: string;
    allowlist: unknown;
    expectedPatterns: string[] | undefined;
  }[])("$name", ({ allowlist, expectedPatterns }) => {
    const file = {
      agents: {
        main: { allowlist } as ExecApprovalsAgent,
      },
      version: 1,
    } satisfies ExecApprovalsFile;
    const entries = normalizeMainAllowlist(file);
    expect(entries?.map((entry) => entry.pattern)).toEqual(expectedPatterns);
    if (entries) {
      expectNoSpreadStringArtifacts(entries);
    }
  });
});

describe("normalizeExecApprovals strips invalid security/ask enum values (#59006)", () => {
  it("drops invalid defaults.security values like 'none'", () => {
    const file = {
      agents: {},
      defaults: { security: "none" },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.security).toBeUndefined();
  });

  it("drops invalid defaults.ask values like 'never'", () => {
    const file = {
      agents: {},
      defaults: { ask: "never" },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.ask).toBeUndefined();
  });

  it("drops invalid defaults.askFallback values", () => {
    const file = {
      agents: {},
      defaults: { askFallback: "none" },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.askFallback).toBeUndefined();
  });

  it("preserves valid defaults.security and defaults.ask values", () => {
    const file: ExecApprovalsFile = {
      agents: {},
      defaults: { ask: "off", askFallback: "deny", security: "full" },
      version: 1,
    };
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.security).toBe("full");
    expect(normalized.defaults?.ask).toBe("off");
    expect(normalized.defaults?.askFallback).toBe("deny");
  });

  it("drops invalid agent-level security/ask values", () => {
    const file = {
      agents: {
        main: { ask: "never", askFallback: "open", security: "none" },
      },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.agents?.main?.security).toBeUndefined();
    expect(normalized.agents?.main?.ask).toBeUndefined();
    expect(normalized.agents?.main?.askFallback).toBeUndefined();
  });

  it("drops invalid wildcard agent security/ask values", () => {
    const file = {
      agents: {
        "*": { ask: "off", security: "none" },
      },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.agents?.["*"]?.security).toBeUndefined();
    expect(normalized.agents?.["*"]?.ask).toBe("off");
  });

  it("resolves to built-in defaults when invalid values are stripped", () => {
    const file = {
      agents: {
        "*": { ask: "off", security: "none" },
      },
      defaults: { ask: "never", security: "none" },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const resolved = resolveExecApprovalsFromFile({ file });
    // Invalid "none" in defaults is stripped, so fallback to DEFAULT_SECURITY ("full")
    expect(resolved.defaults.security).toBe("full");
    // Invalid "never" in defaults is stripped, so fallback to DEFAULT_ASK ("off")
    expect(resolved.defaults.ask).toBe("off");
    // Wildcard agent "none" is stripped, so agent inherits resolved defaults
    expect(resolved.agent.security).toBe("full");
    // Wildcard agent ask="off" is valid and preserved
    expect(resolved.agent.ask).toBe("off");
  });

  it("strips non-string policy values (e.g. numbers, booleans) without throwing", () => {
    const file = {
      agents: {
        main: { ask: false, security: 42 },
      },
      defaults: { ask: true, askFallback: ["deny"], security: 1 },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.security).toBeUndefined();
    expect(normalized.defaults?.ask).toBeUndefined();
    expect(normalized.defaults?.askFallback).toBeUndefined();
    expect(normalized.agents?.main?.security).toBeUndefined();
    expect(normalized.agents?.main?.ask).toBeUndefined();
  });
});
