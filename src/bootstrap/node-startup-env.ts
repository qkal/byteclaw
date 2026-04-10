import { type EnvMap, resolveAutoNodeExtraCaCerts } from "./node-extra-ca-certs.js";

export interface NodeStartupTlsEnvironment {
  NODE_EXTRA_CA_CERTS?: string;
  NODE_USE_SYSTEM_CA?: string;
}

export function resolveNodeStartupTlsEnvironment(
  params: {
    env?: EnvMap;
    platform?: NodeJS.Platform;
    execPath?: string;
    includeDarwinDefaults?: boolean;
    accessSync?: (path: string, mode?: number) => void;
  } = {},
): NodeStartupTlsEnvironment {
  const env = params.env ?? (process.env as EnvMap);
  const platform = params.platform ?? process.platform;
  const includeDarwinDefaults = params.includeDarwinDefaults ?? true;

  const nodeExtraCaCerts =
    env.NODE_EXTRA_CA_CERTS ??
    (platform === "darwin" && includeDarwinDefaults
      ? "/etc/ssl/cert.pem"
      : resolveAutoNodeExtraCaCerts({
          accessSync: params.accessSync,
          env,
          execPath: params.execPath,
          platform,
        }));
  const nodeUseSystemCa =
    env.NODE_USE_SYSTEM_CA ?? (platform === "darwin" && includeDarwinDefaults ? "1" : undefined);

  return {
    NODE_EXTRA_CA_CERTS: nodeExtraCaCerts,
    NODE_USE_SYSTEM_CA: nodeUseSystemCa,
  };
}
