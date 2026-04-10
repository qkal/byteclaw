import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import type { HandleCommandsParams } from "./commands-types.js";

const { installPluginFromPathMock, installPluginFromClawHubMock, persistPluginInstallMock } =
  vi.hoisted(() => ({
    installPluginFromClawHubMock: vi.fn(),
    installPluginFromPathMock: vi.fn(),
    persistPluginInstallMock: vi.fn(),
  }));

vi.mock("../../plugins/install.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/install.js")>(
    "../../plugins/install.js",
  );
  return {
    ...actual,
    installPluginFromPath: installPluginFromPathMock,
  };
});

vi.mock("../../plugins/clawhub.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/clawhub.js")>(
    "../../plugins/clawhub.js",
  );
  return {
    ...actual,
    installPluginFromClawHub: installPluginFromClawHubMock,
  };
});

vi.mock("../../cli/plugins-install-persist.js", () => ({
  persistPluginInstall: persistPluginInstallMock,
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-plugins-install-");

function buildPluginsParams(
  commandBodyNormalized: string,
  workspaceDir: string,
): HandleCommandsParams {
  return {
    cfg: {
      commands: {
        plugins: true,
        text: true,
      },
      plugins: { enabled: true },
    },
    command: {
      channel: "whatsapp",
      channelId: "whatsapp",
      commandBodyNormalized,
      from: "test-user",
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
      senderId: "owner",
      senderIsOwner: true,
      surface: "whatsapp",
      to: "test-bot",
    },
    ctx: {
      AccountId: undefined,
      CommandSource: "text",
      GatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
      Provider: "whatsapp",
      Surface: "whatsapp",
    },
    sessionEntry: {
      sessionId: "session-plugin-command",
      updatedAt: Date.now(),
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
    workspaceDir,
  } as unknown as HandleCommandsParams;
}

describe("handleCommands /plugins install", () => {
  afterEach(async () => {
    installPluginFromPathMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    persistPluginInstallMock.mockReset();
    await workspaceHarness.cleanupWorkspaces();
  });

  it("installs a plugin from a local path", async () => {
    installPluginFromPathMock.mockResolvedValue({
      extensions: ["index.js"],
      ok: true,
      pluginId: "path-install-plugin",
      targetDir: "/tmp/path-install-plugin",
      version: "0.0.1",
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const pluginDir = path.join(workspaceDir, "fixtures", "path-install-plugin");
      await fs.mkdir(pluginDir, { recursive: true });

      const params = buildPluginsParams(`/plugins install ${pluginDir}`, workspaceDir);
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "path-install-plugin"');
      expect(installPluginFromPathMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: pluginDir,
        }),
      );
      expect(persistPluginInstallMock).toHaveBeenCalledWith(
        expect.objectContaining({
          install: expect.objectContaining({
            installPath: "/tmp/path-install-plugin",
            source: "path",
            sourcePath: pluginDir,
            version: "0.0.1",
          }),
          pluginId: "path-install-plugin",
        }),
      );
    });
  });

  it("installs from an explicit clawhub: spec", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      clawhub: {
        clawhubChannel: "official",
        clawhubFamily: "code-plugin",
        clawhubPackage: "@openclaw/clawhub-demo",
        clawhubUrl: "https://clawhub.ai",
        integrity: "sha512-demo",
        resolvedAt: "2026-03-22T12:00:00.000Z",
        source: "clawhub",
        version: "1.2.3",
      },
      extensions: ["index.js"],
      ok: true,
      packageName: "@openclaw/clawhub-demo",
      pluginId: "clawhub-demo",
      targetDir: "/tmp/clawhub-demo",
      version: "1.2.3",
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugins install clawhub:@openclaw/clawhub-demo@1.2.3",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "clawhub-demo"');
      expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: "clawhub:@openclaw/clawhub-demo@1.2.3",
        }),
      );
      expect(persistPluginInstallMock).toHaveBeenCalledWith(
        expect.objectContaining({
          install: expect.objectContaining({
            clawhubChannel: "official",
            clawhubPackage: "@openclaw/clawhub-demo",
            installPath: "/tmp/clawhub-demo",
            integrity: "sha512-demo",
            source: "clawhub",
            spec: "clawhub:@openclaw/clawhub-demo@1.2.3",
            version: "1.2.3",
          }),
          pluginId: "clawhub-demo",
        }),
      );
    });
  });

  it("treats /plugin add as an install alias", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      clawhub: {
        clawhubChannel: "official",
        clawhubFamily: "code-plugin",
        clawhubPackage: "@openclaw/alias-demo",
        clawhubUrl: "https://clawhub.ai",
        integrity: "sha512-alias",
        resolvedAt: "2026-03-23T12:00:00.000Z",
        source: "clawhub",
        version: "1.0.0",
      },
      extensions: ["index.js"],
      ok: true,
      packageName: "@openclaw/alias-demo",
      pluginId: "alias-demo",
      targetDir: "/tmp/alias-demo",
      version: "1.0.0",
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugin add clawhub:@openclaw/alias-demo@1.0.0",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "alias-demo"');
      expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: "clawhub:@openclaw/alias-demo@1.0.0",
        }),
      );
    });
  });
});
