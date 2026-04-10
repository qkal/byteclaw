import type { Command } from "commander";
import { type OpenClawConfig, loadConfig, readConfigFileSnapshot } from "../config/config.js";
import {
  type PluginCliLoaderOptions,
  createPluginCliLogger,
  loadPluginCliDescriptors,
  loadPluginCliRegistrationEntriesWithDefaults,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";

type PluginCliRegistrationMode = "eager" | "lazy";

interface RegisterPluginCliOptions {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
}

const logger = createPluginCliLogger();

export const loadValidatedConfigForPluginRegistration =
  async (): Promise<OpenClawConfig | null> => {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return null;
    }
    return loadConfig();
  };

export async function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<OpenClawPluginCliCommandDescriptor[]> {
  return loadPluginCliDescriptors({ cfg, env, loaderOptions });
}

export async function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
) {
  const mode = options?.mode ?? "eager";
  const primary = options?.primary ?? null;

  await registerPluginCliCommandGroups(
    program,
    await loadPluginCliRegistrationEntriesWithDefaults({ cfg, env, loaderOptions }),
    {
      existingCommands: new Set(program.commands.map((cmd) => cmd.name())),
      logger,
      mode,
      primary,
    },
  );
}

export async function registerPluginCliCommandsFromValidatedConfig(
  program: Command,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig | null> {
  const config = await loadValidatedConfigForPluginRegistration();
  if (!config) {
    return null;
  }
  await registerPluginCliCommands(program, config, env, loaderOptions, options);
  return config;
}
