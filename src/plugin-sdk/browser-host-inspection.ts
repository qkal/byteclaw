import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export interface BrowserExecutable {
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  path: string;
}

interface BrowserHostInspectionSurface {
  resolveGoogleChromeExecutableForPlatform: (platform: NodeJS.Platform) => BrowserExecutable | null;
  readBrowserVersion: (executablePath: string) => string | null;
  parseBrowserMajorVersion: (rawVersion: string | null | undefined) => number | null;
}

function loadBrowserHostInspectionSurface(): BrowserHostInspectionSurface {
  return loadBundledPluginPublicSurfaceModuleSync<BrowserHostInspectionSurface>({
    artifactBasename: "browser-host-inspection.js",
    dirName: "browser",
  });
}

export function resolveGoogleChromeExecutableForPlatform(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  return loadBrowserHostInspectionSurface().resolveGoogleChromeExecutableForPlatform(platform);
}

export function readBrowserVersion(executablePath: string): string | null {
  return loadBrowserHostInspectionSurface().readBrowserVersion(executablePath);
}

export function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null {
  return loadBrowserHostInspectionSurface().parseBrowserMajorVersion(rawVersion);
}
