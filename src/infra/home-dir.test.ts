import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandHomePrefix,
  resolveEffectiveHomeDir,
  resolveHomeRelativePath,
  resolveOsHomeDir,
  resolveOsHomeRelativePath,
  resolveRequiredHomeDir,
} from "./home-dir.js";

describe("resolveEffectiveHomeDir", () => {
  it.each([
    {
      env: {
        HOME: "/home/other",
        OPENCLAW_HOME: " /srv/openclaw-home ",
        USERPROFILE: "C:/Users/other",
      } as NodeJS.ProcessEnv,
      expected: "/srv/openclaw-home",
      homedir: () => "/fallback",
      name: "prefers OPENCLAW_HOME over HOME and USERPROFILE",
    },
    {
      env: { HOME: " /home/alice " } as NodeJS.ProcessEnv,
      expected: "/home/alice",
      name: "falls back to HOME",
    },
    {
      env: {
        HOME: "   ",
        USERPROFILE: " C:/Users/alice ",
      } as NodeJS.ProcessEnv,
      expected: "C:/Users/alice",
      name: "falls back to USERPROFILE when HOME is blank",
    },
    {
      env: {
        HOME: " ",
        OPENCLAW_HOME: " ",
        USERPROFILE: "\t",
      } as NodeJS.ProcessEnv,
      expected: "/fallback",
      homedir: () => " /fallback ",
      name: "falls back to homedir when env values are blank",
    },
    {
      env: {
        HOME: "undefined",
        OPENCLAW_HOME: "undefined",
        USERPROFILE: "null",
      } as NodeJS.ProcessEnv,
      expected: "/fallback",
      homedir: () => " /fallback ",
      name: "treats literal undefined env values as unset",
    },
  ])("$name", ({ env, homedir, expected }) => {
    expect(resolveEffectiveHomeDir(env, homedir)).toBe(path.resolve(expected));
  });

  it.each([
    {
      env: {
        HOME: "/home/alice",
        OPENCLAW_HOME: "~/svc",
      } as NodeJS.ProcessEnv,
      expected: "/home/alice/svc",
      name: "expands ~/ using HOME",
    },
    {
      env: {
        HOME: " ",
        OPENCLAW_HOME: "~\\svc",
        USERPROFILE: "C:/Users/alice",
      } as NodeJS.ProcessEnv,
      expected: "C:/Users/alice\\svc",
      name: "expands ~\\\\ using USERPROFILE",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveEffectiveHomeDir(env)).toBe(path.resolve(expected));
  });
});

describe("resolveRequiredHomeDir", () => {
  it.each([
    {
      env: {} as NodeJS.ProcessEnv,
      expected: process.cwd(),
      homedir: () => {
        throw new Error("no home");
      },
      name: "returns cwd when no home source is available",
    },
    {
      env: { OPENCLAW_HOME: "/custom/home" } as NodeJS.ProcessEnv,
      expected: path.resolve("/custom/home"),
      homedir: () => "/fallback",
      name: "returns a fully resolved path for OPENCLAW_HOME",
    },
    {
      env: { OPENCLAW_HOME: "~" } as NodeJS.ProcessEnv,
      expected: process.cwd(),
      homedir: () => {
        throw new Error("no home");
      },
      name: "returns cwd when OPENCLAW_HOME is tilde-only and no fallback home exists",
    },
  ])("$name", ({ env, homedir, expected }) => {
    expect(resolveRequiredHomeDir(env, homedir)).toBe(expected);
  });
});

describe("resolveOsHomeDir", () => {
  it("ignores OPENCLAW_HOME and uses HOME", () => {
    expect(
      resolveOsHomeDir(
        {
          HOME: "/home/alice",
          OPENCLAW_HOME: "/srv/openclaw-home",
          USERPROFILE: "C:/Users/alice",
        } as NodeJS.ProcessEnv,
        () => "/fallback",
      ),
    ).toBe(path.resolve("/home/alice"));
  });
});

describe("expandHomePrefix", () => {
  it.each([
    {
      expected: `${path.resolve("/srv/openclaw-home")}/x`,
      input: "~/x",
      name: "expands ~/ using effective home",
      opts: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
      },
    },
    {
      expected: "/srv/openclaw-home",
      input: "~",
      name: "expands exact ~ using explicit home",
      opts: { home: " /srv/openclaw-home " },
    },
    {
      expected: `${path.resolve("/home/alice")}\\x`,
      input: "~\\x",
      name: "expands ~\\\\ using resolved env home",
      opts: {
        env: { HOME: "/home/alice" } as NodeJS.ProcessEnv,
      },
    },
    {
      expected: "/tmp/x",
      input: "/tmp/x",
      name: "keeps non-tilde values unchanged",
    },
  ])("$name", ({ input, opts, expected }) => {
    expect(expandHomePrefix(input, opts)).toBe(expected);
  });
});

describe("resolveHomeRelativePath", () => {
  it.each([
    {
      expected: "",
      input: "   ",
      name: "returns blank input unchanged",
    },
    {
      expected: path.resolve("./tmp/file.txt"),
      input: " ./tmp/file.txt ",
      name: "resolves trimmed relative paths",
    },
    {
      expected: path.resolve("/tmp/file.txt"),
      input: " /tmp/file.txt ",
      name: "resolves trimmed absolute paths",
    },
    {
      expected: path.resolve("/srv/openclaw-home/docs"),
      input: "~/docs",
      name: "expands tilde paths using the resolved home directory",
      opts: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
      },
    },
    {
      expected: path.resolve(process.cwd()),
      input: "~",
      name: "falls back to cwd when tilde paths have no home source",
      opts: {
        env: {} as NodeJS.ProcessEnv,
        homedir: () => {
          throw new Error("no home");
        },
      },
    },
  ])("$name", ({ input, opts, expected }) => {
    expect(resolveHomeRelativePath(input, opts)).toBe(expected);
  });
});

describe("resolveOsHomeRelativePath", () => {
  it("expands tilde paths using the OS home instead of OPENCLAW_HOME", () => {
    expect(
      resolveOsHomeRelativePath("~/docs", {
        env: {
          HOME: "/home/alice",
          OPENCLAW_HOME: "/srv/openclaw-home",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/alice/docs"));
  });
});
