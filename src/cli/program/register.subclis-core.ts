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
  type SubCliDescriptor,
  getSubCliCommandsWithSubcommands,
  getSubCliEntries as getSubCliEntryDescriptors,
} from "./subcli-descriptors.js";

export { getSubCliCommandsWithSubcommands };

type SubCliRegistrar = (program: Command) => Promise<void> | void;

async function registerSubCliWithPluginCommands(
  program: Command,
  registerSubCli: () => Promise<void>,
  pluginCliPosition: "before" | "after",
) {
  const { registerPluginCliCommandsFromValidatedConfig } = await import("../../plugins/cli.js");
  if (pluginCliPosition === "before") {
    await registerPluginCliCommandsFromValidatedConfig(program);
  }
  await registerSubCli();
  if (pluginCliPosition === "after") {
    await registerPluginCliCommandsFromValidatedConfig(program);
  }
}

// Note for humans and agents:
// If you update the list of commands, also check whether they have subcommands
// And set the flag accordingly.
const entrySpecs: readonly CommandGroupDescriptorSpec<SubCliRegistrar>[] = [
  ...defineImportedProgramCommandGroupSpecs([
    {
      commandNames: ["acp"],
      exportName: "registerAcpCli",
      loadModule: () => import("../acp-cli.js"),
    },
    {
      commandNames: ["gateway"],
      exportName: "registerGatewayCli",
      loadModule: () => import("../gateway-cli.js"),
    },
    {
      commandNames: ["daemon"],
      exportName: "registerDaemonCli",
      loadModule: () => import("../daemon-cli.js"),
    },
    {
      commandNames: ["logs"],
      exportName: "registerLogsCli",
      loadModule: () => import("../logs-cli.js"),
    },
    {
      commandNames: ["system"],
      exportName: "registerSystemCli",
      loadModule: () => import("../system-cli.js"),
    },
    {
      commandNames: ["models"],
      exportName: "registerModelsCli",
      loadModule: () => import("../models-cli.js"),
    },
    {
      commandNames: ["infer", "capability"],
      exportName: "registerCapabilityCli",
      loadModule: () => import("../capability-cli.js"),
    },
    {
      commandNames: ["approvals"],
      exportName: "registerExecApprovalsCli",
      loadModule: () => import("../exec-approvals-cli.js"),
    },
    {
      commandNames: ["exec-policy"],
      exportName: "registerExecPolicyCli",
      loadModule: () => import("../exec-policy-cli.js"),
    },
    {
      commandNames: ["nodes"],
      exportName: "registerNodesCli",
      loadModule: () => import("../nodes-cli.js"),
    },
    {
      commandNames: ["devices"],
      exportName: "registerDevicesCli",
      loadModule: () => import("../devices-cli.js"),
    },
    {
      commandNames: ["node"],
      exportName: "registerNodeCli",
      loadModule: () => import("../node-cli.js"),
    },
    {
      commandNames: ["sandbox"],
      exportName: "registerSandboxCli",
      loadModule: () => import("../sandbox-cli.js"),
    },
    {
      commandNames: ["tui"],
      exportName: "registerTuiCli",
      loadModule: () => import("../tui-cli.js"),
    },
    {
      commandNames: ["cron"],
      exportName: "registerCronCli",
      loadModule: () => import("../cron-cli.js"),
    },
    {
      commandNames: ["dns"],
      exportName: "registerDnsCli",
      loadModule: () => import("../dns-cli.js"),
    },
    {
      commandNames: ["docs"],
      exportName: "registerDocsCli",
      loadModule: () => import("../docs-cli.js"),
    },
    {
      commandNames: ["qa"],
      exportName: "registerQaCli",
      loadModule: () => import("../qa-cli.js"),
    },
    {
      commandNames: ["hooks"],
      exportName: "registerHooksCli",
      loadModule: () => import("../hooks-cli.js"),
    },
    {
      commandNames: ["webhooks"],
      exportName: "registerWebhooksCli",
      loadModule: () => import("../webhooks-cli.js"),
    },
    {
      commandNames: ["qr"],
      exportName: "registerQrCli",
      loadModule: () => import("../qr-cli.js"),
    },
    {
      commandNames: ["clawbot"],
      exportName: "registerClawbotCli",
      loadModule: () => import("../clawbot-cli.js"),
    },
  ]),
  {
    commandNames: ["pairing"],
    register: async (program) => {
      await registerSubCliWithPluginCommands(
        program,
        async () => {
          const mod = await import("../pairing-cli.js");
          mod.registerPairingCli(program);
        },
        "before",
      );
    },
  },
  {
    commandNames: ["plugins"],
    register: async (program) => {
      await registerSubCliWithPluginCommands(
        program,
        async () => {
          const mod = await import("../plugins-cli.js");
          mod.registerPluginsCli(program);
        },
        "after",
      );
    },
  },
  ...defineImportedProgramCommandGroupSpecs([
    {
      commandNames: ["channels"],
      exportName: "registerChannelsCli",
      loadModule: () => import("../channels-cli.js"),
    },
    {
      commandNames: ["directory"],
      exportName: "registerDirectoryCli",
      loadModule: () => import("../directory-cli.js"),
    },
    {
      commandNames: ["security"],
      exportName: "registerSecurityCli",
      loadModule: () => import("../security-cli.js"),
    },
    {
      commandNames: ["secrets"],
      exportName: "registerSecretsCli",
      loadModule: () => import("../secrets-cli.js"),
    },
    {
      commandNames: ["skills"],
      exportName: "registerSkillsCli",
      loadModule: () => import("../skills-cli.js"),
    },
    {
      commandNames: ["update"],
      exportName: "registerUpdateCli",
      loadModule: () => import("../update-cli.js"),
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
  return registerCommandGroupByName(program, resolveSubCliCommandGroups(), name);
}

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveSubCliCommandGroups(), {
    eager: shouldEagerRegisterSubcommands(),
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimarySubcommandOnly(argv)),
  });
}
