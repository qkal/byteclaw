import { type OpenClawConfig, createConfigIO, getRuntimeConfigSnapshot } from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfigSnapshot() ?? createConfigIO().loadConfig();
}
