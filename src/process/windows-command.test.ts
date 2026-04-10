import { describe, expect, it } from "vitest";
import { resolveWindowsCommandShim } from "./windows-command.js";

describe("resolveWindowsCommandShim", () => {
  it("leaves commands unchanged outside Windows", () => {
    expect(
      resolveWindowsCommandShim({
        cmdCommands: ["pnpm"],
        command: "pnpm",
        platform: "linux",
      }),
    ).toBe("pnpm");
  });

  it("appends .cmd for configured Windows shims", () => {
    expect(
      resolveWindowsCommandShim({
        cmdCommands: ["corepack", "pnpm", "yarn"],
        command: "pnpm",
        platform: "win32",
      }),
    ).toBe("pnpm.cmd");
  });

  it("appends .cmd for corepack on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        cmdCommands: ["corepack", "pnpm", "yarn"],
        command: "corepack",
        platform: "win32",
      }),
    ).toBe("corepack.cmd");
  });

  it("keeps explicit extensions on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        cmdCommands: ["npm", "npx"],
        command: "npm.cmd",
        platform: "win32",
      }),
    ).toBe("npm.cmd");
  });
});
