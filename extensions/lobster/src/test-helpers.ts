type PathEnvKey = "PATH" | "Path" | "PATHEXT" | "Pathext";

export { createWindowsCmdShimFixture } from "openclaw/plugin-sdk/testing";
const PATH_ENV_KEYS = ["PATH", "Path", "PATHEXT", "Pathext"] as const;

export interface PlatformPathEnvSnapshot {
  platformDescriptor: PropertyDescriptor | undefined;
  env: Record<PathEnvKey, string | undefined>;
}

export function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

export function snapshotPlatformPathEnv(): PlatformPathEnvSnapshot {
  return {
    env: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      Path: process.env.Path,
      Pathext: process.env.Pathext,
    },
    platformDescriptor: Object.getOwnPropertyDescriptor(process, "platform"),
  };
}

export function restorePlatformPathEnv(snapshot: PlatformPathEnvSnapshot): void {
  if (snapshot.platformDescriptor) {
    Object.defineProperty(process, "platform", snapshot.platformDescriptor);
  }

  for (const key of PATH_ENV_KEYS) {
    const value = snapshot.env[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}
