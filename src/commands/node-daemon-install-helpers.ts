import { formatNodeServiceDescription } from "../daemon/constants.js";
import { resolveNodeProgramArguments } from "../daemon/program-args.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { NodeDaemonRuntime } from "./node-daemon-runtime.js";

export interface NodeInstallPlan {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  description?: string;
}

export async function buildNodeInstallPlan(params: {
  env: Record<string, string | undefined>;
  host: string;
  port: number;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  runtime: NodeDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<NodeInstallPlan> {
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    devMode: params.devMode,
    env: params.env,
    nodePath: params.nodePath,
    runtime: params.runtime,
  });
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    dev: devMode,
    displayName: params.displayName,
    host: params.host,
    nodeId: params.nodeId,
    nodePath,
    port: params.port,
    runtime: params.runtime,
    tls: params.tls,
    tlsFingerprint: params.tlsFingerprint,
  });

  await emitDaemonInstallRuntimeWarning({
    env: params.env,
    programArguments,
    runtime: params.runtime,
    title: "Node daemon runtime",
    warn: params.warn,
  });

  const environment = buildNodeServiceEnvironment({
    env: params.env,
    // Match the gateway install path so supervised node services keep the chosen
    // Node toolchain on PATH for sibling binaries like npm/pnpm when needed.
    extraPathDirs: resolveDaemonNodeBinDir(nodePath),
  });
  const description = formatNodeServiceDescription({
    version: environment.OPENCLAW_SERVICE_VERSION,
  });

  return { description, environment, programArguments, workingDirectory };
}
