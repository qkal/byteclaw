import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  hasHelpOrVersion,
  isRootHelpInvocation,
} from "./argv.js";

export interface CliArgvInvocation {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
}

export function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation {
  return {
    argv,
    commandPath: getCommandPathWithRootOptions(argv, 2),
    hasHelpOrVersion: hasHelpOrVersion(argv),
    isRootHelpInvocation: isRootHelpInvocation(argv),
    primary: getPrimaryCommand(argv),
  };
}
