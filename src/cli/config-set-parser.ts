export type ConfigSetMode = "value" | "json" | "ref_builder" | "provider_builder" | "batch";

export type ConfigSetModeResolution =
  | {
      ok: true;
      mode: ConfigSetMode;
    }
  | {
      ok: false;
      error: string;
    };

export function resolveConfigSetMode(params: {
  hasBatchMode: boolean;
  hasRefBuilderOptions: boolean;
  hasProviderBuilderOptions: boolean;
  strictJson: boolean;
}): ConfigSetModeResolution {
  if (params.hasBatchMode) {
    if (params.hasRefBuilderOptions || params.hasProviderBuilderOptions) {
      return {
        error:
          "batch mode (--batch-json/--batch-file) cannot be combined with ref builder (--ref-*) or provider builder (--provider-*) flags.",
        ok: false,
      };
    }
    return { mode: "batch", ok: true };
  }
  if (params.hasRefBuilderOptions && params.hasProviderBuilderOptions) {
    return {
      error:
        "choose exactly one mode: ref builder (--ref-provider/--ref-source/--ref-id) or provider builder (--provider-*), not both.",
      ok: false,
    };
  }
  if (params.hasRefBuilderOptions) {
    return { mode: "ref_builder", ok: true };
  }
  if (params.hasProviderBuilderOptions) {
    return { mode: "provider_builder", ok: true };
  }
  return { mode: params.strictJson ? "json" : "value", ok: true };
}
