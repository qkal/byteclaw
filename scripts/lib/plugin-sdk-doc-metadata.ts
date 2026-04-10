export type PluginSdkDocCategory =
  | "account"
  | "approval"
  | "browser"
  | "config"
  | "core"
  | "provider"
  | "routing"
  | "runtime"
  | "sandbox"
  | "security";

export type PluginSdkDocEntrypoint =
  | "index"
  | "core"
  | "provider-setup"
  | "sandbox"
  | "self-hosted-provider-setup"
  | "routing"
  | "runtime"
  | "runtime-doctor"
  | "runtime-env"
  | "runtime-secret-resolution";

export interface PluginSdkDocMetadata {
  category: PluginSdkDocCategory;
  entrypoint: PluginSdkDocEntrypoint;
}

export const pluginSdkDocMetadata: Record<PluginSdkDocEntrypoint, PluginSdkDocMetadata> = {
  index: { category: "core", entrypoint: "index" },
  core: { category: "core", entrypoint: "core" },
  "provider-setup": { category: "provider", entrypoint: "provider-setup" },
  sandbox: { category: "sandbox", entrypoint: "sandbox" },
  "self-hosted-provider-setup": {
    category: "provider",
    entrypoint: "self-hosted-provider-setup",
  },
  routing: { category: "routing", entrypoint: "routing" },
  runtime: { category: "runtime", entrypoint: "runtime" },
  "runtime-doctor": { category: "runtime", entrypoint: "runtime-doctor" },
  "runtime-env": { category: "runtime", entrypoint: "runtime-env" },
  "runtime-secret-resolution": {
    category: "runtime",
    entrypoint: "runtime-secret-resolution",
  },
};

export function resolvePluginSdkDocImportSpecifier(
  entrypoint: PluginSdkDocEntrypoint,
): string {
  return entrypoint === "index" ? "openclaw/plugin-sdk" : `openclaw/plugin-sdk/${entrypoint}`;
}
