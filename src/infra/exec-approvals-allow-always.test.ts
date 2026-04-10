import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
  makePathEnv,
  makeTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateShellAllowlist,
  requiresExecApproval,
  resolveAllowAlwaysPatterns,
  resolveSafeBins,
} from "./exec-approvals.js";
import { matchAllowlist } from "./exec-command-resolution.js";

describe("resolveAllowAlwaysPatterns", () => {
  function makeExecutable(dir: string, name: string): string {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const exe = path.join(dir, fileName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    return exe;
  }

  function resolvePersistedPatterns(params: {
    command: string;
    dir: string;
    env: Record<string, string | undefined>;
    safeBins: ReturnType<typeof resolveSafeBins>;
    strictInlineEval?: boolean;
  }) {
    const analysis = evaluateShellAllowlist({
      allowlist: [],
      command: params.command,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
      safeBins: params.safeBins,
    });
    return {
      analysis,
      persisted: resolveAllowAlwaysPatterns({
        cwd: params.dir,
        env: params.env,
        platform: process.platform,
        segments: analysis.segments,
        strictInlineEval: params.strictInlineEval,
      }),
    };
  }

  function expectAllowAlwaysBypassBlocked(params: {
    dir: string;
    firstCommand: string;
    secondCommand: string;
    env: Record<string, string | undefined>;
    persistedPattern: string;
  }) {
    const safeBins = resolveSafeBins(undefined);
    const { persisted } = resolvePersistedPatterns({
      command: params.firstCommand,
      dir: params.dir,
      env: params.env,
      safeBins,
    });
    expect(persisted).toEqual([params.persistedPattern]);

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: params.persistedPattern }],
      command: params.secondCommand,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        allowlistSatisfied: second.allowlistSatisfied,
        analysisOk: second.analysisOk,
        ask: "on-miss",
        security: "allowlist",
      }),
    ).toBe(true);
  }

  function createShellScriptFixture() {
    const dir = makeTempDir();
    const scriptsDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = path.join(scriptsDir, "save_crystal.sh");
    fs.writeFileSync(script, "echo ok\n");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);
    return { dir, env, safeBins, script, scriptsDir };
  }

  function expectPersistedShellScriptMatch(params: {
    command: string;
    script: string;
    dir: string;
    env: Record<string, string | undefined>;
    safeBins: ReturnType<typeof resolveSafeBins>;
  }) {
    const { persisted } = resolvePersistedPatterns({
      command: params.command,
      dir: params.dir,
      env: params.env,
      safeBins: params.safeBins,
    });
    expect(persisted).toEqual([params.script]);

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: params.script }],
      command: params.command,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
      safeBins: params.safeBins,
    });
    expect(second.allowlistSatisfied).toBe(true);
  }

  function expectShellScriptFallbackRejected(command: string) {
    const { dir, scriptsDir, script, env, safeBins } = createShellScriptFixture();
    const rcFile = path.join(scriptsDir, "evilrc");
    fs.writeFileSync(rcFile, "echo blocked\n");

    const { persisted } = resolvePersistedPatterns({
      command,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toEqual([]);

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: script }],
      command,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(false);
  }

  function expectPositionalArgvCarrierResult(params: {
    command: string;
    expectPersisted: boolean;
  }) {
    const dir = makeTempDir();
    const touch = makeExecutable(dir, "touch");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);
    const marker = path.join(dir, "marker");
    const command = params.command.replaceAll("{marker}", marker);

    const { persisted } = resolvePersistedPatterns({
      command,
      dir,
      env,
      safeBins,
    });
    if (params.expectPersisted) {
      expect(persisted).toEqual([touch]);
    } else {
      expect(persisted).toEqual([]);
    }

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: touch }],
      command,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(params.expectPersisted);
  }

  it("returns direct executable paths for non-shell segments", () => {
    const exe = path.join("/tmp", "openclaw-tool");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          argv: [exe],
          raw: exe,
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "openclaw-tool",
              rawExecutable: exe,
              resolvedPath: exe,
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([exe]);
  });

  it("does not persist interpreter-like executables for allow-always", () => {
    const awk = path.join("/tmp", "awk");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          argv: [awk, "{print $1}", "data.csv"],
          raw: `${awk} '{print $1}' data.csv`,
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "awk",
              rawExecutable: awk,
              resolvedPath: awk,
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([]);
  });

  it("persists benign awk interpreters when strict inline-eval is enabled", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const awk = makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = resolvePersistedPatterns({
      command: "awk -F, -f script.awk data.csv",
      dir,
      env,
      safeBins,
      strictInlineEval: true,
    });
    expect(persisted).toEqual([awk]);

    const second = evaluateShellAllowlist({
      allowlist: persisted.map((pattern) => ({ pattern })),
      command: "awk -F, -f script.awk data.csv",
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(true);
  });

  it("keeps Windows strict inline-eval interpreter approvals argv-bound", () => {
    const awk = String.raw`C:\temp\awk.exe`;
    const resolution = makeMockCommandResolution({
      execution: makeMockExecutableResolution({
        executableName: "awk",
        rawExecutable: awk,
        resolvedPath: awk,
      }),
    });
    const entries = resolveAllowAlwaysPatternEntries({
      platform: "win32",
      segments: [
        {
          argv: [awk, "-F", ",", "-f", "script.awk", "data.csv"],
          raw: `${awk} -F , -f script.awk data.csv`,
          resolution,
        },
      ],
      strictInlineEval: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        argPattern: expect.any(String),
        pattern: awk,
      }),
    ]);
    expect(
      matchAllowlist(
        entries,
        resolution.execution ?? null,
        [awk, "-F", ",", "-f", "script.awk", "data.csv"],
        "win32",
      ),
    ).toEqual(expect.objectContaining({ argPattern: expect.any(String), pattern: awk }));
    expect(
      matchAllowlist(
        entries,
        resolution.execution ?? null,
        [awk, "-f", "other.awk", "secrets.csv"],
        "win32",
      ),
    ).toBeNull();
  });

  it("keeps inline awk programs out of allow-always persistence in strict inline-eval mode", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = resolvePersistedPatterns({
      command: `awk 'BEGIN{system("id > ${path.join(dir, "marker")}")}'`,
      dir,
      env,
      safeBins,
      strictInlineEval: true,
    });
    expect(persisted).toEqual([]);
  });

  it("unwraps shell wrappers and persists the inner executable instead", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const patterns = resolveAllowAlwaysPatterns({
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
      segments: [
        {
          argv: ["/bin/zsh", "-lc", "whoami"],
          raw: "/bin/zsh -lc 'whoami'",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "/bin/zsh",
              resolvedPath: "/bin/zsh",
              executableName: "zsh",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/bin/zsh");
  });

  it("extracts all inner binaries from shell chains and deduplicates", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const ls = makeExecutable(dir, "ls");
    const patterns = resolveAllowAlwaysPatterns({
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
      segments: [
        {
          argv: ["/bin/zsh", "-lc", "whoami && ls && whoami"],
          raw: "/bin/zsh -lc 'whoami && ls && whoami'",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "/bin/zsh",
              resolvedPath: "/bin/zsh",
              executableName: "zsh",
            }),
          }),
        },
      ],
    });
    expect(new Set(patterns)).toEqual(new Set([whoami, ls]));
  });

  it("persists shell script paths for wrapper invocations without inline commands", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, scriptsDir, script, env, safeBins } = createShellScriptFixture();
    expectPersistedShellScriptMatch({
      command: "bash scripts/save_crystal.sh",
      dir,
      env,
      safeBins,
      script,
    });

    const other = path.join(scriptsDir, "other.sh");
    fs.writeFileSync(other, "echo other\n");
    const third = evaluateShellAllowlist({
      allowlist: [{ pattern: script }],
      command: "bash scripts/other.sh",
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(third.allowlistSatisfied).toBe(false);
  });

  it("matches persisted shell script paths through dispatch wrappers", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, script, env, safeBins } = createShellScriptFixture();
    expectPersistedShellScriptMatch({
      command: "/usr/bin/nice bash scripts/save_crystal.sh",
      dir,
      env,
      safeBins,
      script,
    });
  });

  it("rejects shell rc and init-file options as persisted or allowlisted script paths", () => {
    if (process.platform === "win32") {
      return;
    }
    for (const command of [
      "bash --rcfile scripts/evilrc scripts/save_crystal.sh",
      "bash --init-file scripts/evilrc scripts/save_crystal.sh",
      "bash --startup-file scripts/evilrc scripts/save_crystal.sh",
    ]) {
      expectShellScriptFallbackRejected(command);
    }
  });

  it("rejects shell rc and init-file equals options as persisted or allowlisted script paths", () => {
    if (process.platform === "win32") {
      return;
    }
    for (const command of [
      "bash --rcfile=scripts/evilrc scripts/save_crystal.sh",
      "bash --init-file=scripts/evilrc scripts/save_crystal.sh",
      "bash --startup-file=scripts/evilrc scripts/save_crystal.sh",
    ]) {
      expectShellScriptFallbackRejected(command);
    }
  });

  it("rejects shell-wrapper positional argv carriers", () => {
    if (process.platform === "win32") {
      return;
    }
    expectPositionalArgvCarrierResult({
      command: `sh -lc '$0 "$1"' touch {marker}`,
      expectPersisted: true,
    });
  });

  it("rejects exec positional argv carriers", () => {
    if (process.platform === "win32") {
      return;
    }
    expectPositionalArgvCarrierResult({
      command: `sh -lc 'exec -- "$0" "$1"' touch {marker}`,
      expectPersisted: true,
    });
  });

  it("rejects positional argv carriers when $0 is single-quoted", () => {
    if (process.platform === "win32") {
      return;
    }
    expectPositionalArgvCarrierResult({
      command: `sh -lc "'$0' "$1"" touch {marker}`,
      expectPersisted: false,
    });
  });

  it("rejects positional argv carriers when exec is separated from $0 by a newline", () => {
    if (process.platform === "win32") {
      return;
    }
    expectPositionalArgvCarrierResult({
      command: `sh -lc "exec
$0 \\"$1\\"" touch {marker}`,
      expectPersisted: false,
    });
  });

  it("rejects positional argv carriers when inline command contains extra shell operations", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const touch = makeExecutable(dir, "touch");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);
    const marker = path.join(dir, "marker");

    const { persisted } = resolvePersistedPatterns({
      command: `sh -lc 'echo blocked; $0 "$1"' touch ${marker}`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).not.toContain(touch);

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: touch }],
      command: `sh -lc 'echo blocked; $0 "$1"' touch ${marker}`,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("does not treat inline shell commands as persisted script paths", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, script, env } = createShellScriptFixture();
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "bash scripts/save_crystal.sh",
      persistedPattern: script,
      secondCommand: "bash -lc 'scripts/save_crystal.sh'",
    });
  });

  it("does not treat stdin shell mode as a persisted script path", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, script, env } = createShellScriptFixture();
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "bash scripts/save_crystal.sh",
      persistedPattern: script,
      secondCommand: "bash -s scripts/save_crystal.sh",
    });
  });

  it("does not persist broad shell binaries when no inner command can be derived", () => {
    const patterns = resolveAllowAlwaysPatterns({
      platform: process.platform,
      segments: [
        {
          argv: ["/bin/zsh", "-s"],
          raw: "/bin/zsh -s",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "/bin/zsh",
              resolvedPath: "/bin/zsh",
              executableName: "zsh",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([]);
  });

  it("detects shell wrappers even when unresolved executableName is a full path", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const patterns = resolveAllowAlwaysPatterns({
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
      segments: [
        {
          argv: ["/usr/local/bin/zsh", "-lc", "whoami"],
          raw: "/usr/local/bin/zsh -lc whoami",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "/usr/local/bin/zsh",
              resolvedPath: undefined,
              executableName: "/usr/local/bin/zsh",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([whoami]);
  });

  it("unwraps known dispatch wrappers before shell wrappers", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const patterns = resolveAllowAlwaysPatterns({
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
      segments: [
        {
          argv: ["/usr/bin/nice", "/bin/zsh", "-lc", "whoami"],
          raw: "/usr/bin/nice /bin/zsh -lc whoami",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "/usr/bin/nice",
              resolvedPath: "/usr/bin/nice",
              executableName: "nice",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/usr/bin/nice");
  });

  it("unwraps time wrappers and persists the inner executable instead", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const patterns = resolveAllowAlwaysPatterns({
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
      segments: [
        {
          argv: ["/usr/bin/time", "-p", "/bin/zsh", "-lc", "whoami"],
          raw: "/usr/bin/time -p /bin/zsh -lc whoami",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "/usr/bin/time",
              resolvedPath: "/usr/bin/time",
              executableName: "time",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/usr/bin/time");
  });

  it("unwraps busybox/toybox shell applets and persists inner executables", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    makeExecutable(dir, "toybox");
    const whoami = makeExecutable(dir, "whoami");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const patterns = resolveAllowAlwaysPatterns({
      cwd: dir,
      env,
      platform: process.platform,
      segments: [
        {
          argv: [busybox, "sh", "-lc", "whoami"],
          raw: `${busybox} sh -lc whoami`,
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: busybox,
              resolvedPath: busybox,
              executableName: "busybox",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain(busybox);
  });

  it("fails closed for unsupported busybox/toybox applets", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    const patterns = resolveAllowAlwaysPatterns({
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
      segments: [
        {
          argv: [busybox, "sed", "-n", "1p"],
          raw: `${busybox} sed -n 1p`,
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: busybox,
              resolvedPath: busybox,
              executableName: "busybox",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([]);
  });

  it("fails closed for unresolved dispatch wrappers", () => {
    const patterns = resolveAllowAlwaysPatterns({
      platform: process.platform,
      segments: [
        {
          argv: ["sudo", "/bin/zsh", "-lc", "whoami"],
          raw: "sudo /bin/zsh -lc whoami",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "sudo",
              resolvedPath: "/usr/bin/sudo",
              executableName: "sudo",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([]);
  });

  it("prevents allow-always bypass for busybox shell applets", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: `${busybox} sh -c 'echo warmup-ok'`,
      persistedPattern: echo,
      secondCommand: `${busybox} sh -c 'id > marker'`,
    });
  });

  it("prevents allow-always bypass for caffeinate wrapper chains", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "/usr/bin/caffeinate -d -w 42 /bin/zsh -lc 'echo warmup-ok'",
      persistedPattern: echo,
      secondCommand: "/usr/bin/caffeinate -d -w 42 /bin/zsh -lc 'id > marker'",
    });
  });

  it("prevents allow-always bypass for dispatch-wrapper + shell-wrapper chains", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "/usr/bin/nice /bin/zsh -lc 'echo warmup-ok'",
      persistedPattern: echo,
      secondCommand: "/usr/bin/nice /bin/zsh -lc 'id > marker'",
    });
  });

  it("prevents allow-always bypass for sandbox-exec wrapper chains", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand:
        "/usr/bin/sandbox-exec -p '(deny default) (allow process*)' /bin/zsh -lc 'echo warmup-ok'",
      persistedPattern: echo,
      secondCommand: "/usr/bin/sandbox-exec -p '(allow default)' /bin/zsh -lc 'id > marker'",
    });
  });

  it("prevents allow-always bypass for time wrapper chains", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "/usr/bin/time -p /bin/zsh -lc 'echo warmup-ok'",
      persistedPattern: echo,
      secondCommand: "/usr/bin/time -p /bin/zsh -lc 'id > marker'",
    });
  });

  it("prevents allow-always bypass for macOS dispatch-wrapper chains", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "/usr/bin/arch -arm64 /bin/zsh -lc 'echo warmup-ok'",
      persistedPattern: echo,
      secondCommand: "/usr/bin/arch -arm64 /bin/zsh -lc 'id > marker-arch'",
    });
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "/usr/bin/xcrun /bin/zsh -lc 'echo warmup-ok'",
      persistedPattern: echo,
      secondCommand: "/usr/bin/xcrun /bin/zsh -lc 'id > marker-xcrun'",
    });
  });

  it("prevents allow-always bypass for awk interpreters", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = resolvePersistedPatterns({
      command: "awk '{print $1}' data.csv",
      dir,
      env,
      safeBins,
    });
    expect(persisted).toEqual([]);

    const second = evaluateShellAllowlist({
      allowlist: persisted.map((pattern) => ({ pattern })),
      command: `awk 'BEGIN{system("id > ${path.join(dir, "marker")}")}'`,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        allowlistSatisfied: second.allowlistSatisfied,
        analysisOk: second.analysisOk,
        ask: "on-miss",
        security: "allowlist",
      }),
    ).toBe(true);
  });

  it("prevents allow-always bypass for shell-carried awk interpreters", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = resolvePersistedPatterns({
      command: `sh -lc '$0 "$@"' awk '{print $1}' data.csv`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toEqual([]);

    const second = evaluateShellAllowlist({
      allowlist: persisted.map((pattern) => ({ pattern })),
      command: `sh -lc '$0 "$@"' awk 'BEGIN{system("id > /tmp/pwned")}'`,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("prevents allow-always bypass for script wrapper chains", () => {
    if (process.platform !== "darwin" && process.platform !== "freebsd") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: "/usr/bin/script -q /dev/null /bin/sh -lc 'echo warmup-ok'",
      persistedPattern: echo,
      secondCommand: "/usr/bin/script -q /dev/null /bin/sh -lc 'id > marker'",
    });
  });

  it("does not persist comment-tailed payload paths that never execute", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const benign = makeExecutable(dir, "benign");
    makeExecutable(dir, "payload");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      env,
      firstCommand: `${benign} warmup # && payload`,
      persistedPattern: benign,
      secondCommand: "payload",
    });
  });

  it("rejects positional carrier when carried executable is a dispatch wrapper", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const envPath = makeExecutable(dir, "env");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = resolvePersistedPatterns({
      command: `sh -lc '$0 "$@"' env echo SAFE`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toEqual([]);

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: envPath }],
      command: `sh -lc '$0 "$@"' env BASH_ENV=/tmp/payload.sh bash -lc 'id > /tmp/pwned'`,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("rejects positional carrier when carried executable is a shell wrapper", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const bashPath = makeExecutable(dir, "bash");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = resolvePersistedPatterns({
      command: `sh -lc '$0 "$@"' bash -lc 'echo safe'`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toEqual([]);

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: bashPath }],
      command: `sh -lc '$0 "$@"' bash -lc 'id > /tmp/pwned'`,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("allows positional carriers for unknown carried executables when explicitly allowlisted", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const xargsPath = makeExecutable(dir, "xargs");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = resolvePersistedPatterns({
      command: `sh -lc '$0 "$@"' xargs echo SAFE`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toEqual([]);

    const second = evaluateShellAllowlist({
      allowlist: [{ pattern: xargsPath }],
      command: `sh -lc '$0 "$@"' xargs sh -lc 'id > /tmp/pwned'`,
      cwd: dir,
      env,
      platform: process.platform,
      safeBins,
    });
    expect(second.allowlistSatisfied).toBe(true);
  });
});
