import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import {
  shouldEagerRegisterSubcommands,
  shouldRegisterPrimarySubcommandOnly,
} from "../command-registration-policy.js";
import {
  type CommandGroupDescriptorSpec,
  buildCommandGroupEntries,
  defineImportedProgramCommandGroupSpecs,
} from "./command-group-descriptors.js";
import {
  type CommandGroupEntry,
  registerCommandGroupByName,
  registerCommandGroups,
} from "./register-command-groups.js";
import {
  registerSubCliByName as registerSubCliByNameCore,
  registerSubCliCommands as registerSubCliCommandsCore,
} from "./register.subclis-core.js";
import {
  type SubCliDescriptor,
  getSubCliCommandsWithSubcommands,
  getSubCliEntries as getSubCliEntryDescriptors,
} from "./subcli-descriptors.js";

export { getSubCliCommandsWithSubcommands };

type SubCliRegistrar = (program: Command) => Promise<void> | void;

const entrySpecs: readonly CommandGroupDescriptorSpec<SubCliRegistrar>[] = [
  ...defineImportedProgramCommandGroupSpecs([
    {
      commandNames: ["completion"],
      exportName: "registerCompletionCli",
      loadModule: () => import("../completion-cli.js"),
    },
  ]),
];

function resolveSubCliCommandGroups(): CommandGroupEntry[] {
  return buildCommandGroupEntries(getSubCliEntryDescriptors(), entrySpecs, (register) => register);
}

export function getSubCliEntries(): readonly SubCliDescriptor[] {
  return getSubCliEntryDescriptors();
}

export async function registerSubCliByName(program: Command, name: string): Promise<boolean> {
  if (await registerSubCliByNameCore(program, name)) {
    return true;
  }
  return registerCommandGroupByName(program, resolveSubCliCommandGroups(), name);
}

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  registerSubCliCommandsCore(program, argv);
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveSubCliCommandGroups(), {
    eager: shouldEagerRegisterSubcommands(),
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimarySubcommandOnly(argv)),
  });
}
