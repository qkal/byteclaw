import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isCommandFlagEnabled,
  isNativeCommandsExplicitlyDisabled,
  isRestartEnabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "./commands.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "discord" }),
          commands: {
            nativeCommandsAutoEnabled: true,
            nativeSkillsAutoEnabled: true,
          },
        },
        pluginId: "discord",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          commands: {
            nativeCommandsAutoEnabled: true,
            nativeSkillsAutoEnabled: true,
          },
        },
        pluginId: "telegram",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "slack" }),
          commands: {
            nativeCommandsAutoEnabled: false,
            nativeSkillsAutoEnabled: false,
          },
        },
        pluginId: "slack",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "whatsapp" }),
          commands: {
            nativeCommandsAutoEnabled: false,
            nativeSkillsAutoEnabled: false,
          },
        },
        pluginId: "whatsapp",
        source: "test",
      },
    ]),
  );
});

describe("resolveNativeSkillsEnabled", () => {
  it("uses provider defaults for auto", () => {
    expect(
      resolveNativeSkillsEnabled({
        globalSetting: "auto",
        providerId: "discord",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        globalSetting: "auto",
        providerId: "telegram",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        globalSetting: "auto",
        providerId: "slack",
      }),
    ).toBe(false);
    expect(
      resolveNativeSkillsEnabled({
        globalSetting: "auto",
        providerId: "whatsapp",
      }),
    ).toBe(false);
  });

  it("honors explicit provider settings", () => {
    expect(
      resolveNativeSkillsEnabled({
        globalSetting: "auto",
        providerId: "slack",
        providerSetting: true,
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        globalSetting: true,
        providerId: "discord",
        providerSetting: false,
      }),
    ).toBe(false);
  });
});

describe("resolveNativeCommandsEnabled", () => {
  it("follows the same provider default heuristic", () => {
    expect(resolveNativeCommandsEnabled({ globalSetting: "auto", providerId: "discord" })).toBe(
      true,
    );
    expect(resolveNativeCommandsEnabled({ globalSetting: "auto", providerId: "telegram" })).toBe(
      true,
    );
    expect(resolveNativeCommandsEnabled({ globalSetting: "auto", providerId: "slack" })).toBe(
      false,
    );
  });

  it("honors explicit provider/global booleans", () => {
    expect(
      resolveNativeCommandsEnabled({
        globalSetting: false,
        providerId: "slack",
        providerSetting: true,
      }),
    ).toBe(true);
    expect(
      resolveNativeCommandsEnabled({
        globalSetting: false,
        providerId: "discord",
      }),
    ).toBe(false);
  });
});

describe("isNativeCommandsExplicitlyDisabled", () => {
  it("returns true only for explicit false at provider or fallback global", () => {
    expect(
      isNativeCommandsExplicitlyDisabled({ globalSetting: true, providerSetting: false }),
    ).toBe(true);
    expect(
      isNativeCommandsExplicitlyDisabled({ globalSetting: false, providerSetting: undefined }),
    ).toBe(true);
    expect(
      isNativeCommandsExplicitlyDisabled({ globalSetting: false, providerSetting: true }),
    ).toBe(false);
    expect(
      isNativeCommandsExplicitlyDisabled({ globalSetting: false, providerSetting: "auto" }),
    ).toBe(false);
  });
});

describe("isRestartEnabled", () => {
  it("defaults to enabled unless explicitly false", () => {
    expect(isRestartEnabled(undefined)).toBe(true);
    expect(isRestartEnabled({})).toBe(true);
    expect(isRestartEnabled({ commands: {} })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: true } })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: false } })).toBe(false);
  });

  it("ignores inherited restart flags", () => {
    expect(
      isRestartEnabled({
        commands: Object.create({ restart: false }) as Record<string, unknown>,
      }),
    ).toBe(true);
  });
});

describe("isCommandFlagEnabled", () => {
  it("requires own boolean true", () => {
    expect(isCommandFlagEnabled({ commands: { bash: true } }, "bash")).toBe(true);
    expect(isCommandFlagEnabled({ commands: { bash: false } }, "bash")).toBe(false);
    expect(
      isCommandFlagEnabled(
        {
          commands: Object.create({ bash: true }) as Record<string, unknown>,
        },
        "bash",
      ),
    ).toBe(false);
  });
});
