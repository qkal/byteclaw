import { describe, expect, it } from "vitest";
import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";
import {
  parseSetUnsetCommand,
  parseSetUnsetCommandAction,
  parseSlashCommandWithSetUnset,
} from "./commands-setunset.js";

type ParsedSetUnsetAction =
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

function createActionMappers() {
  return {
    onError: (message: string): ParsedSetUnsetAction => ({ action: "error", message }),
    onSet: (path: string, value: unknown): ParsedSetUnsetAction => ({ action: "set", path, value }),
    onUnset: (path: string): ParsedSetUnsetAction => ({ action: "unset", path }),
  };
}

function createSlashParams(params: {
  raw: string;
  onKnownAction?: (action: string) => ParsedSetUnsetAction | undefined;
}) {
  return {
    invalidMessage: "Invalid /config syntax.",
    onKnownAction: params.onKnownAction ?? (() => undefined),
    raw: params.raw,
    slash: "/config",
    usageMessage: "Usage: /config show|set|unset",
    ...createActionMappers(),
  };
}

describe("parseSetUnsetCommand", () => {
  it("parses unset values", () => {
    expect(
      parseSetUnsetCommand({
        action: "unset",
        args: "foo.bar",
        slash: "/config",
      }),
    ).toEqual({ kind: "unset", path: "foo.bar" });
  });

  it("parses set values", () => {
    expect(
      parseSetUnsetCommand({
        action: "set",
        args: 'foo.bar={"x":1}',
        slash: "/config",
      }),
    ).toEqual({ kind: "set", path: "foo.bar", value: { x: 1 } });
  });
});

describe("parseSetUnsetCommandAction", () => {
  it("returns null for non set/unset actions", () => {
    const mappers = createActionMappers();
    const result = parseSetUnsetCommandAction<ParsedSetUnsetAction>({
      action: "show",
      args: "",
      slash: "/config",
      ...mappers,
    });
    expect(result).toBeNull();
  });

  it("maps parse errors through onError", () => {
    const mappers = createActionMappers();
    const result = parseSetUnsetCommandAction<ParsedSetUnsetAction>({
      action: "set",
      args: "",
      slash: "/config",
      ...mappers,
    });
    expect(result).toEqual({ action: "error", message: "Usage: /config set path=value" });
  });
});

describe("parseSlashCommandWithSetUnset", () => {
  it("returns null when the input does not match the slash command", () => {
    const result = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({ raw: "/debug show" }),
    );
    expect(result).toBeNull();
  });

  it("prefers set/unset mapping and falls back to known actions", () => {
    const setResult = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({
        raw: '/config set a.b={"ok":true}',
      }),
    );
    expect(setResult).toEqual({ action: "set", path: "a.b", value: { ok: true } });

    const showResult = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({
        onKnownAction: (action) =>
          action === "show" ? { action: "unset", path: "dummy" } : undefined,
        raw: "/config show",
      }),
    );
    expect(showResult).toEqual({ action: "unset", path: "dummy" });
  });

  it("returns onError for unknown actions", () => {
    const unknownAction = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({
        raw: "/config whoami",
      }),
    );
    expect(unknownAction).toEqual({ action: "error", message: "Usage: /config show|set|unset" });
  });
});

describe("parseStandardSetUnsetSlashCommand", () => {
  it("uses default set/unset/error mappings", () => {
    const result = parseStandardSetUnsetSlashCommand<ParsedSetUnsetAction>({
      invalidMessage: "Invalid /config syntax.",
      onKnownAction: () => undefined,
      raw: '/config set a.b={"ok":true}',
      slash: "/config",
      usageMessage: "Usage: /config show|set|unset",
    });
    expect(result).toEqual({ action: "set", path: "a.b", value: { ok: true } });
  });

  it("supports caller-provided mappings", () => {
    const result = parseStandardSetUnsetSlashCommand<ParsedSetUnsetAction>({
      invalidMessage: "Invalid /config syntax.",
      onKnownAction: () => undefined,
      onUnset: (path) => ({ action: "unset", path: `wrapped:${path}` }),
      raw: "/config unset a.b",
      slash: "/config",
      usageMessage: "Usage: /config show|set|unset",
    });
    expect(result).toEqual({ action: "unset", path: "wrapped:a.b" });
  });
});
