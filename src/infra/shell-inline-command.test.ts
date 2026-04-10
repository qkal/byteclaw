import { describe, expect, it } from "vitest";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  POWERSHELL_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "./shell-inline-command.js";

describe("resolveInlineCommandMatch", () => {
  it.each([
    {
      argv: ["bash", "-lc", "echo hi"],
      expected: { command: "echo hi", valueTokenIndex: 2 },
      flags: POSIX_INLINE_COMMAND_FLAGS,
      name: "extracts the next token for bash -lc",
    },
    {
      argv: ["pwsh", "-Command", "Get-ChildItem"],
      expected: { command: "Get-ChildItem", valueTokenIndex: 2 },
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      name: "extracts the next token for PowerShell -Command",
    },
    {
      argv: ["pwsh", "-File", "script.ps1"],
      expected: { command: "script.ps1", valueTokenIndex: 2 },
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      name: "extracts the next token for PowerShell -File",
    },
    {
      argv: ["powershell", "-f", "script.ps1"],
      expected: { command: "script.ps1", valueTokenIndex: 2 },
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      name: "extracts the next token for PowerShell -f",
    },
    {
      argv: ["sh", "-cecho hi"],
      expected: { command: "echo hi", valueTokenIndex: 1 },
      flags: POSIX_INLINE_COMMAND_FLAGS,
      name: "supports combined -c forms when enabled",
      opts: { allowCombinedC: true },
    },
    {
      argv: ["sh", "-cecho hi"],
      expected: { command: null, valueTokenIndex: null },
      flags: POSIX_INLINE_COMMAND_FLAGS,
      name: "rejects combined -c forms when disabled",
      opts: { allowCombinedC: false },
    },
    {
      argv: ["bash", "-lc", "   "],
      expected: { command: null, valueTokenIndex: 2 },
      flags: POSIX_INLINE_COMMAND_FLAGS,
      name: "returns a value index for blank command tokens",
    },
    {
      argv: ["bash", "-lc"],
      expected: { command: null, valueTokenIndex: null },
      flags: POSIX_INLINE_COMMAND_FLAGS,
      name: "returns null value index when the flag has no following token",
    },
  ])("$name", ({ argv, flags, opts, expected }) => {
    expect(resolveInlineCommandMatch(argv, flags, opts)).toEqual(expected);
  });

  it("stops parsing after --", () => {
    expect(
      resolveInlineCommandMatch(["bash", "--", "-lc", "echo hi"], POSIX_INLINE_COMMAND_FLAGS),
    ).toEqual({
      command: null,
      valueTokenIndex: null,
    });
  });
});
