import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { shouldRegisterPrimaryCommandOnly } from "../command-registration-policy.js";
import {
  type CommandGroupDescriptorSpec,
  buildCommandGroupEntries,
  defineImportedCommandGroupSpec,
  defineImportedProgramCommandGroupSpecs,
} from "./command-group-descriptors.js";
import type { ProgramContext } from "./context.js";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandsWithSubcommands,
  getCoreCliCommandNames as getCoreDescriptorNames,
} from "./core-command-descriptors.js";
import {
  type CommandGroupEntry,
  registerCommandGroupByName,
  registerCommandGroups,
} from "./register-command-groups.js";

export { getCoreCliCommandDescriptors, getCoreCliCommandsWithSubcommands };

interface CommandRegisterParams {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
}

export interface CommandRegistration {
  id: string;
  register: (params: CommandRegisterParams) => void;
}

function withProgramOnlySpecs(
  specs: readonly CommandGroupDescriptorSpec<(program: Command) => Promise<void> | void>[],
): CommandGroupDescriptorSpec<(params: CommandRegisterParams) => Promise<void>>[] {
  return specs.map((spec) => ({
    commandNames: spec.commandNames,
    register: async ({ program }) => {
      await spec.register(program);
    },
  }));
}

// Note for humans and agents:
// If you update the list of commands, also check whether they have subcommands
// And set the flag accordingly.
const coreEntrySpecs: readonly CommandGroupDescriptorSpec<
  (params: CommandRegisterParams) => Promise<void> | void
>[] = [
  ...withProgramOnlySpecs(
    defineImportedProgramCommandGroupSpecs([
      {
        commandNames: ["setup"],
        exportName: "registerSetupCommand",
        loadModule: () => import("./register.setup.js"),
      },
      {
        commandNames: ["onboard"],
        exportName: "registerOnboardCommand",
        loadModule: () => import("./register.onboard.js"),
      },
      {
        commandNames: ["configure"],
        exportName: "registerConfigureCommand",
        loadModule: () => import("./register.configure.js"),
      },
      {
        commandNames: ["config"],
        exportName: "registerConfigCli",
        loadModule: () => import("../config-cli.js"),
      },
      {
        commandNames: ["backup"],
        exportName: "registerBackupCommand",
        loadModule: () => import("./register.backup.js"),
      },
      {
        commandNames: ["doctor", "dashboard", "reset", "uninstall"],
        exportName: "registerMaintenanceCommands",
        loadModule: () => import("./register.maintenance.js"),
      },
    ]),
  ),
  defineImportedCommandGroupSpec(
    ["message"],
    () => import("./register.message.js"),
    (mod, { program, ctx }) => {
      mod.registerMessageCommands(program, ctx);
    },
  ),
  ...withProgramOnlySpecs(
    defineImportedProgramCommandGroupSpecs([
      {
        commandNames: ["mcp"],
        exportName: "registerMcpCli",
        loadModule: () => import("../mcp-cli.js"),
      },
    ]),
  ),
  defineImportedCommandGroupSpec(
    ["agent", "agents"],
    () => import("./register.agent.js"),
    (mod, { program, ctx }) => {
      mod.registerAgentCommands(program, {
        agentChannelOptions: ctx.agentChannelOptions,
      });
    },
  ),
  ...withProgramOnlySpecs(
    defineImportedProgramCommandGroupSpecs([
      {
        commandNames: ["status", "health", "sessions", "tasks"],
        exportName: "registerStatusHealthSessionsCommands",
        loadModule: () => import("./register.status-health-sessions.js"),
      },
    ]),
  ),
];

function resolveCoreCommandGroups(ctx: ProgramContext, argv: string[]): CommandGroupEntry[] {
  return buildCommandGroupEntries(
    getCoreCliCommandDescriptors(),
    coreEntrySpecs,
    (register) => async (program) => {
      await register({ argv, ctx, program });
    },
  );
}

export function getCoreCliCommandNames(): string[] {
  return getCoreDescriptorNames();
}

export async function registerCoreCliByName(
  program: Command,
  ctx: ProgramContext,
  name: string,
  argv: string[] = process.argv,
): Promise<boolean> {
  return registerCommandGroupByName(program, resolveCoreCommandGroups(ctx, argv), name);
}

export function registerCoreCliCommands(program: Command, ctx: ProgramContext, argv: string[]) {
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveCoreCommandGroups(ctx, argv), {
    eager: false,
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimaryCommandOnly(argv)),
  });
}
