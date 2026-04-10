import type { OpenClawConfig } from "openclaw/plugin-sdk/browser-config-runtime";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "openclaw/plugin-sdk/browser-config-runtime";

export function isDefaultBrowserPluginEnabled(cfg: OpenClawConfig): boolean {
  return resolveEffectiveEnableState({
    config: normalizePluginsConfig(cfg.plugins),
    enabledByDefault: true,
    id: "browser",
    origin: "bundled",
    rootConfig: cfg,
  }).enabled;
}
