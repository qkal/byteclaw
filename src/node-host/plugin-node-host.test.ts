import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  invokeRegisteredNodeHostCommand,
  listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("plugin node-host registry", () => {
  it("lists plugin-declared caps and commands", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        command: {
          cap: "browser",
          command: "browser.proxy",
          handle: vi.fn(async () => "{}"),
        },
        pluginId: "browser",
        pluginName: "Browser",
        source: "test",
      },
      {
        command: {
          cap: "photos",
          command: "photos.proxy",
          handle: vi.fn(async () => "{}"),
        },
        pluginId: "photos",
        pluginName: "Photos",
        source: "test",
      },
      {
        command: {
          cap: "browser",
          command: "browser.inspect",
          handle: vi.fn(async () => "{}"),
        },
        pluginId: "browser-dup",
        pluginName: "Browser Dup",
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands()).toEqual({
      caps: ["browser", "photos"],
      commands: ["browser.inspect", "browser.proxy", "photos.proxy"],
    });
  });

  it("dispatches plugin-declared node-host commands", async () => {
    const handle = vi.fn(async (paramsJSON?: string | null) => paramsJSON ?? "");
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        command: {
          cap: "browser",
          command: "browser.proxy",
          handle,
        },
        pluginId: "browser",
        pluginName: "Browser",
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    await expect(invokeRegisteredNodeHostCommand("browser.proxy", '{"ok":true}')).resolves.toBe(
      '{"ok":true}',
    );
    await expect(invokeRegisteredNodeHostCommand("missing.command", null)).resolves.toBeNull();
    expect(handle).toHaveBeenCalledWith('{"ok":true}');
  });
});
