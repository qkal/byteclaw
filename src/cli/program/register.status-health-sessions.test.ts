import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  flowsCancelCommand: vi.fn(),
  flowsListCommand: vi.fn(),
  flowsShowCommand: vi.fn(),
  healthCommand: vi.fn(),
  runtime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  },
  sessionsCleanupCommand: vi.fn(),
  sessionsCommand: vi.fn(),
  setVerbose: vi.fn(),
  statusCommand: vi.fn(),
  tasksAuditCommand: vi.fn(),
  tasksCancelCommand: vi.fn(),
  tasksListCommand: vi.fn(),
  tasksMaintenanceCommand: vi.fn(),
  tasksNotifyCommand: vi.fn(),
  tasksShowCommand: vi.fn(),
}));

const {statusCommand} = mocks;
const {healthCommand} = mocks;
const {sessionsCommand} = mocks;
const {sessionsCleanupCommand} = mocks;
const {tasksListCommand} = mocks;
const {tasksAuditCommand} = mocks;
const {tasksMaintenanceCommand} = mocks;
const {tasksShowCommand} = mocks;
const {tasksNotifyCommand} = mocks;
const {tasksCancelCommand} = mocks;
const {flowsListCommand} = mocks;
const {flowsShowCommand} = mocks;
const {flowsCancelCommand} = mocks;
const {setVerbose} = mocks;
const {runtime} = mocks;

vi.mock("../../commands/status.js", () => ({
  statusCommand: mocks.statusCommand,
}));

vi.mock("../../commands/health.js", () => ({
  healthCommand: mocks.healthCommand,
}));

vi.mock("../../commands/sessions.js", () => ({
  sessionsCommand: mocks.sessionsCommand,
}));

vi.mock("../../commands/sessions-cleanup.js", () => ({
  sessionsCleanupCommand: mocks.sessionsCleanupCommand,
}));

vi.mock("../../commands/tasks.js", () => ({
  tasksAuditCommand: mocks.tasksAuditCommand,
  tasksCancelCommand: mocks.tasksCancelCommand,
  tasksListCommand: mocks.tasksListCommand,
  tasksMaintenanceCommand: mocks.tasksMaintenanceCommand,
  tasksNotifyCommand: mocks.tasksNotifyCommand,
  tasksShowCommand: mocks.tasksShowCommand,
}));

vi.mock("../../commands/flows.js", () => ({
  flowsCancelCommand: mocks.flowsCancelCommand,
  flowsListCommand: mocks.flowsListCommand,
  flowsShowCommand: mocks.flowsShowCommand,
}));

vi.mock("../../globals.js", () => ({
  setVerbose: mocks.setVerbose,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerStatusHealthSessionsCommands", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerStatusHealthSessionsCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.exit.mockImplementation(() => {});
    statusCommand.mockResolvedValue(undefined);
    healthCommand.mockResolvedValue(undefined);
    sessionsCommand.mockResolvedValue(undefined);
    sessionsCleanupCommand.mockResolvedValue(undefined);
    tasksListCommand.mockResolvedValue(undefined);
    tasksAuditCommand.mockResolvedValue(undefined);
    tasksMaintenanceCommand.mockResolvedValue(undefined);
    tasksShowCommand.mockResolvedValue(undefined);
    tasksNotifyCommand.mockResolvedValue(undefined);
    tasksCancelCommand.mockResolvedValue(undefined);
    flowsListCommand.mockResolvedValue(undefined);
    flowsShowCommand.mockResolvedValue(undefined);
    flowsCancelCommand.mockResolvedValue(undefined);
  });

  it("runs status command with timeout and debug-derived verbose", async () => {
    await runCli([
      "status",
      "--json",
      "--all",
      "--deep",
      "--usage",
      "--debug",
      "--timeout",
      "5000",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expect(statusCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        all: true,
        deep: true,
        json: true,
        timeoutMs: 5000,
        usage: true,
        verbose: true,
      }),
      runtime,
    );
  });

  it("rejects invalid status timeout without calling status command", async () => {
    await runCli(["status", "--timeout", "nope"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(statusCommand).not.toHaveBeenCalled();
  });

  it("runs health command with parsed timeout", async () => {
    await runCli(["health", "--json", "--timeout", "2500", "--verbose"]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expect(healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        timeoutMs: 2500,
        verbose: true,
      }),
      runtime,
    );
  });

  it("rejects invalid health timeout without calling health command", async () => {
    await runCli(["health", "--timeout", "0"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(healthCommand).not.toHaveBeenCalled();
  });

  it("runs sessions command with forwarded options", async () => {
    await runCli([
      "sessions",
      "--json",
      "--verbose",
      "--store",
      "/tmp/sessions.json",
      "--active",
      "120",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expect(sessionsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        active: "120",
        json: true,
        store: "/tmp/sessions.json",
      }),
      runtime,
    );
  });

  it("runs sessions command with --agent forwarding", async () => {
    await runCli(["sessions", "--agent", "work"]);

    expect(sessionsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "work",
        allAgents: false,
      }),
      runtime,
    );
  });

  it("runs sessions command with --all-agents forwarding", async () => {
    await runCli(["sessions", "--all-agents"]);

    expect(sessionsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allAgents: true,
      }),
      runtime,
    );
  });

  it("runs sessions cleanup subcommand with forwarded options", async () => {
    await runCli([
      "sessions",
      "cleanup",
      "--store",
      "/tmp/sessions.json",
      "--dry-run",
      "--enforce",
      "--fix-missing",
      "--active-key",
      "agent:main:main",
      "--json",
    ]);

    expect(sessionsCleanupCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        activeKey: "agent:main:main",
        agent: undefined,
        allAgents: false,
        dryRun: true,
        enforce: true,
        fixMissing: true,
        json: true,
        store: "/tmp/sessions.json",
      }),
      runtime,
    );
  });

  it("forwards parent-level all-agents to cleanup subcommand", async () => {
    await runCli(["sessions", "--all-agents", "cleanup", "--dry-run"]);

    expect(sessionsCleanupCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allAgents: true,
      }),
      runtime,
    );
  });

  it("runs tasks list from the parent command", async () => {
    await runCli(["tasks", "--json", "--runtime", "acp", "--status", "running"]);

    expect(tasksListCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        runtime: "acp",
        status: "running",
      }),
      runtime,
    );
  });

  it("runs tasks show subcommand with lookup forwarding", async () => {
    await runCli(["tasks", "show", "run-123", "--json"]);

    expect(tasksShowCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        lookup: "run-123",
      }),
      runtime,
    );
  });

  it("runs tasks maintenance subcommand with apply forwarding", async () => {
    await runCli(["tasks", "--json", "maintenance", "--apply"]);

    expect(tasksMaintenanceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: true,
        json: true,
      }),
      runtime,
    );
  });

  it("runs tasks audit subcommand with filters", async () => {
    await runCli([
      "tasks",
      "--json",
      "audit",
      "--severity",
      "error",
      "--code",
      "stale_running",
      "--limit",
      "5",
    ]);

    expect(tasksAuditCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "stale_running",
        json: true,
        limit: 5,
        severity: "error",
      }),
      runtime,
    );
  });

  it("routes tasks flow commands through the TaskFlow handlers", async () => {
    await runCli(["tasks", "flow", "list", "--json", "--status", "blocked"]);
    expect(flowsListCommand).toHaveBeenCalledWith(expect.any(Object), runtime);

    await runCli(["tasks", "flow", "show", "flow-123", "--json"]);
    expect(flowsShowCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "flow-123",
      }),
      runtime,
    );

    await runCli(["tasks", "flow", "cancel", "flow-123"]);
    expect(flowsCancelCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "flow-123",
      }),
      runtime,
    );
  });

  it("runs tasks notify subcommand with lookup and policy forwarding", async () => {
    await runCli(["tasks", "notify", "run-123", "state_changes"]);

    expect(tasksNotifyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "run-123",
        notify: "state_changes",
      }),
      runtime,
    );
  });

  it("runs tasks cancel subcommand with lookup forwarding", async () => {
    await runCli(["tasks", "cancel", "run-123"]);

    expect(tasksCancelCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "run-123",
      }),
      runtime,
    );
  });

  it("does not register the legacy top-level flows command", () => {
    const program = new Command();
    registerStatusHealthSessionsCommands(program);

    expect(program.commands.find((command) => command.name() === "flows")).toBeUndefined();
  });
});
