import type { OpenClawConfig } from "../config/config.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export interface BrowserControlAuth {
  token?: string;
  password?: string;
}

interface EnsureBrowserControlAuthParams {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}

interface EnsureBrowserControlAuthResult {
  auth: BrowserControlAuth;
  generatedToken?: string;
}

interface BrowserControlAuthSurface {
  resolveBrowserControlAuth: (cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv) => BrowserControlAuth;
  shouldAutoGenerateBrowserAuth: (env: NodeJS.ProcessEnv) => boolean;
  ensureBrowserControlAuth: (
    params: EnsureBrowserControlAuthParams,
  ) => Promise<EnsureBrowserControlAuthResult>;
}

function loadBrowserControlAuthSurface(): BrowserControlAuthSurface {
  return loadBundledPluginPublicSurfaceModuleSync<BrowserControlAuthSurface>({
    artifactBasename: "browser-control-auth.js",
    dirName: "browser",
  });
}

export function resolveBrowserControlAuth(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  return loadBrowserControlAuthSurface().resolveBrowserControlAuth(cfg, env);
}

export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  return loadBrowserControlAuthSurface().shouldAutoGenerateBrowserAuth(env);
}

export async function ensureBrowserControlAuth(
  params: EnsureBrowserControlAuthParams,
): Promise<EnsureBrowserControlAuthResult> {
  return await loadBrowserControlAuthSurface().ensureBrowserControlAuth(params);
}
