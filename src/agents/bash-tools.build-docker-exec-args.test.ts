import { describe, expect, it } from "vitest";
import { buildDockerExecArgs } from "./bash-tools.shared.js";

describe("buildDockerExecArgs", () => {
  it("prepends custom PATH after login shell sourcing to preserve both custom and system tools", () => {
    const args = buildDockerExecArgs({
      command: "echo hello",
      containerName: "test-container",
      env: {
        HOME: "/home/user",
        PATH: "/custom/bin:/usr/local/bin:/usr/bin",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(args).toContain("OPENCLAW_PREPEND_PATH=/custom/bin:/usr/local/bin:/usr/bin");
    expect(commandArg).toContain('export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"');
    expect(commandArg).toContain("echo hello");
    expect(commandArg).toBe(
      'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; echo hello',
    );
  });

  it("does not interpolate PATH into the shell command", () => {
    const injectedPath = "$(touch /tmp/openclaw-path-injection)";
    const args = buildDockerExecArgs({
      command: "echo hello",
      containerName: "test-container",
      env: {
        HOME: "/home/user",
        PATH: injectedPath,
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(args).toContain(`OPENCLAW_PREPEND_PATH=${injectedPath}`);
    expect(commandArg).not.toContain(injectedPath);
    expect(commandArg).toContain("OPENCLAW_PREPEND_PATH");
  });

  it("does not add PATH export when PATH is not in env", () => {
    const args = buildDockerExecArgs({
      command: "echo hello",
      containerName: "test-container",
      env: {
        HOME: "/home/user",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(commandArg).toBe("echo hello");
    expect(commandArg).not.toContain("export PATH");
  });

  it("includes workdir flag when specified", () => {
    const args = buildDockerExecArgs({
      command: "pwd",
      containerName: "test-container",
      env: { HOME: "/home/user" },
      tty: false,
      workdir: "/workspace",
    });

    expect(args).toContain("-w");
    expect(args).toContain("/workspace");
  });

  it("uses login shell for consistent environment", () => {
    const args = buildDockerExecArgs({
      command: "echo test",
      containerName: "test-container",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(args).toContain("/bin/sh");
    expect(args).toContain("-lc");
  });

  it("includes tty flag when requested", () => {
    const args = buildDockerExecArgs({
      command: "bash",
      containerName: "test-container",
      env: { HOME: "/home/user" },
      tty: true,
    });

    expect(args).toContain("-t");
  });
});
