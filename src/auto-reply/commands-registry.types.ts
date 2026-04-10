import type { OpenClawConfig } from "../config/types.js";

export type CommandScope = "text" | "native" | "both";

export type CommandCategory =
  | "session"
  | "options"
  | "status"
  | "management"
  | "media"
  | "tools"
  | "docks";

export type CommandArgType = "string" | "number" | "boolean";

export interface CommandArgChoiceContext {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
}

export type CommandArgChoice = string | { value: string; label: string };

export type CommandArgChoicesProvider = (context: CommandArgChoiceContext) => CommandArgChoice[];

export interface CommandArgDefinition {
  name: string;
  description: string;
  type: CommandArgType;
  required?: boolean;
  choices?: CommandArgChoice[] | CommandArgChoicesProvider;
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
}

export interface CommandArgMenuSpec {
  arg: string;
  title?: string;
}

export type CommandArgValue = string | number | boolean | bigint;
export type CommandArgValues = Record<string, CommandArgValue>;

export interface CommandArgs {
  raw?: string;
  values?: CommandArgValues;
}

export type CommandArgsParsing = "none" | "positional";

export interface ChatCommandDefinition {
  key: string;
  nativeName?: string;
  description: string;
  textAliases: string[];
  acceptsArgs?: boolean;
  args?: CommandArgDefinition[];
  argsParsing?: CommandArgsParsing;
  formatArgs?: (values: CommandArgValues) => string | undefined;
  argsMenu?: CommandArgMenuSpec | "auto";
  scope: CommandScope;
  category?: CommandCategory;
}

export interface NativeCommandSpec {
  name: string;
  description: string;
  acceptsArgs: boolean;
  args?: CommandArgDefinition[];
}

export interface CommandNormalizeOptions {
  botUsername?: string;
}

export interface CommandDetection {
  exact: Set<string>;
  regex: RegExp;
}

export interface ShouldHandleTextCommandsParams {
  cfg: OpenClawConfig;
  surface: string;
  commandSource?: "text" | "native";
}
