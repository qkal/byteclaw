import { beforeEach, describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  buildPluginDiagnosticsReport,
  buildPluginSnapshotReport,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeLogs,
} from "./plugins-cli-test-helpers.js";

describe("plugins cli list", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("includes imported state in JSON output", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginRecord({
          activated: true,
          explicitlyEnabled: true,
          id: "demo",
          imported: true,
        }),
      ],
      workspaceDir: "/workspace",
    });

    await runPluginsCommand(["plugins", "list", "--json"]);

    expect(buildPluginSnapshotReport).toHaveBeenCalledWith();

    expect(JSON.parse(runtimeLogs[0] ?? "null")).toEqual({
      diagnostics: [],
      plugins: [
        expect.objectContaining({
          activated: true,
          explicitlyEnabled: true,
          id: "demo",
          imported: true,
        }),
      ],
      workspaceDir: "/workspace",
    });
  });

  it("shows imported state in verbose output", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginRecord({
          activated: true,
          explicitlyEnabled: false,
          id: "demo",
          imported: false,
          name: "Demo Plugin",
        }),
      ],
    });

    await runPluginsCommand(["plugins", "list", "--verbose"]);

    expect(buildPluginSnapshotReport).toHaveBeenCalledWith();

    const output = runtimeLogs.join("\n");
    expect(output).toContain("activated: yes");
    expect(output).toContain("imported: no");
    expect(output).toContain("explicitly enabled: no");
  });

  it("sanitizes activation reasons in verbose output", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginRecord({
          activated: true,
          activationReason: "\u001B[31mconfigured\nnext\tstep",
          activationSource: "auto",
          id: "demo",
          name: "Demo Plugin",
        }),
      ],
    });

    await runPluginsCommand(["plugins", "list", "--verbose"]);

    const output = runtimeLogs.join("\n");
    expect(output).toContain(String.raw`activation reason: configured\nnext\tstep`);
    expect(output).not.toContain("\u001B[31m");
    expect(output.match(/activation reason:/g)).toHaveLength(1);
  });

  it("keeps doctor on a module-loading snapshot", async () => {
    buildPluginDiagnosticsReport.mockReturnValue({
      diagnostics: [],
      plugins: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(buildPluginDiagnosticsReport).toHaveBeenCalledWith();
    expect(runtimeLogs).toContain("No plugin issues detected.");
  });
});
