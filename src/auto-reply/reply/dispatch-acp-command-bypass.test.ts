import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import { buildTestCtx } from "./test-ctx.js";

describe("shouldBypassAcpDispatchForCommand", () => {
  it("returns false for plain-text ACP turns", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "write a test",
      BodyForCommands: "write a test",
      Provider: "discord",
      Surface: "discord",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for ACP slash commands", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "/acp cancel",
      BodyForCommands: "/acp cancel",
      CommandBody: "/acp cancel",
      Provider: "discord",
      Surface: "discord",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns true for ACP reset-tail slash commands", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "/new continue with deployment",
      BodyForCommands: "/new continue with deployment",
      CommandBody: "/new continue with deployment",
      CommandSource: "native",
      Provider: "discord",
      Surface: "discord",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for bare ACP reset slash commands", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "/reset",
      BodyForCommands: "/reset",
      CommandBody: "/reset",
      Provider: "discord",
      Surface: "discord",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for slash commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "/acp cancel",
      BodyForCommands: "/acp cancel",
      CommandBody: "/acp cancel",
      CommandSource: "text",
      Provider: "discord",
      Surface: "discord",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns false for unauthorized bang-prefixed commands", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "!poll",
      BodyForCommands: "!poll",
      CommandAuthorized: false,
      CommandBody: "!poll",
      Provider: "discord",
      Surface: "discord",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for bang-prefixed commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "!poll",
      BodyForCommands: "!poll",
      CommandAuthorized: true,
      CommandBody: "!poll",
      CommandSource: "text",
      Provider: "discord",
      Surface: "discord",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns true for authorized bang-prefixed commands when text commands are enabled", () => {
    const ctx = buildTestCtx({
      BodyForAgent: "!poll",
      BodyForCommands: "!poll",
      CommandAuthorized: true,
      CommandBody: "!poll",
      CommandSource: "text",
      Provider: "discord",
      Surface: "discord",
    });
    const cfg = {
      commands: {
        bash: true,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });
});
