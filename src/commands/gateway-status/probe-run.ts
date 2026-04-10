import type { OpenClawConfig } from "../../config/types.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  type GatewayBonjourBeacon,
  discoverGatewayBeacons,
} from "../../infra/bonjour-discovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import { pickAutoSshTargetFromDiscovery } from "./discovery.js";
import {
  type GatewayConfigSummary,
  type GatewayStatusTarget,
  extractConfigSummary,
  pickGatewaySelfPresence,
  resolveAuthForTarget,
  resolveProbeBudgetMs,
} from "./helpers.js";

export interface GatewayStatusProbedTarget {
  target: GatewayStatusTarget;
  probe: Awaited<ReturnType<typeof probeGateway>>;
  configSummary: GatewayConfigSummary | null;
  self: ReturnType<typeof pickGatewaySelfPresence>;
  authDiagnostics: string[];
}

export async function runGatewayStatusProbePass(params: {
  cfg: OpenClawConfig;
  opts: {
    token?: string;
    password?: string;
    sshAuto?: boolean;
  };
  overallTimeoutMs: number;
  discoveryTimeoutMs: number;
  wideAreaDomain?: string | null;
  baseTargets: GatewayStatusTarget[];
  remotePort: number;
  sshTarget: string | null;
  sshIdentity: string | null;
  loadSshTunnelModule: () => Promise<typeof import("../../infra/ssh-tunnel.js")>;
  localTlsFingerprint?: string;
}): Promise<{
  discovery: GatewayBonjourBeacon[];
  probed: GatewayStatusProbedTarget[];
  sshTarget: string | null;
  sshTunnelStarted: boolean;
  sshTunnelError: string | null;
}> {
  const discoveryPromise = discoverGatewayBeacons({
    timeoutMs: params.discoveryTimeoutMs,
    wideAreaDomain: params.wideAreaDomain,
  });

  let {sshTarget} = params;
  let sshTunnelError: string | null = null;
  let sshTunnelStarted = false;

  const tryStartTunnel = async () => {
    if (!sshTarget) {
      return null;
    }
    try {
      const { startSshPortForward } = await params.loadSshTunnelModule();
      const tunnel = await startSshPortForward({
        identity: params.sshIdentity ?? undefined,
        localPortPreferred: params.remotePort,
        remotePort: params.remotePort,
        target: sshTarget,
        timeoutMs: Math.min(1500, params.overallTimeoutMs),
      });
      sshTunnelStarted = true;
      return tunnel;
    } catch (error) {
      sshTunnelError = formatErrorMessage(error);
      return null;
    }
  };

  const discoveryTask = discoveryPromise.catch(() => []);
  const tunnelTask = sshTarget ? tryStartTunnel() : Promise.resolve(null);
  const [discovery, tunnelFirst] = await Promise.all([discoveryTask, tunnelTask]);

  if (!sshTarget && params.opts.sshAuto) {
    const { parseSshTarget } = await params.loadSshTunnelModule();
    sshTarget = pickAutoSshTargetFromDiscovery({
      discovery,
      parseSshTarget,
      sshUser: normalizeOptionalString(process.env.USER) ?? "",
    });
  }

  const tunnel =
    tunnelFirst ||
    (sshTarget && !sshTunnelStarted && !sshTunnelError ? await tryStartTunnel() : null);

  const tunnelTarget: GatewayStatusTarget | null = tunnel
    ? {
        active: true,
        id: "sshTunnel",
        kind: "sshTunnel",
        tunnel: {
          kind: "ssh",
          localPort: tunnel.localPort,
          pid: tunnel.pid,
          remotePort: params.remotePort,
          target: sshTarget ?? "",
        },
        url: `ws://127.0.0.1:${tunnel.localPort}`,
      }
    : null;

  const targets: GatewayStatusTarget[] = tunnelTarget
    ? [tunnelTarget, ...params.baseTargets.filter((target) => target.url !== tunnelTarget.url)]
    : params.baseTargets;

  try {
    const probed = await Promise.all(
      targets.map(async (target) => {
        const authResolution = await resolveAuthForTarget(params.cfg, target, {
          password: readStringValue(params.opts.password),
          token: readStringValue(params.opts.token),
        });
        const probe = await probeGateway({
          auth: {
            password: authResolution.password,
            token: authResolution.token,
          },
          timeoutMs: resolveProbeBudgetMs(params.overallTimeoutMs, target),
          tlsFingerprint:
            target.kind === "localLoopback" && target.url.startsWith("wss://")
              ? params.localTlsFingerprint
              : undefined,
          url: target.url,
        });
        return {
          authDiagnostics: authResolution.diagnostics ?? [],
          configSummary: probe.configSnapshot ? extractConfigSummary(probe.configSnapshot) : null,
          probe,
          self: pickGatewaySelfPresence(probe.presence),
          target,
        };
      }),
    );

    return {
      discovery,
      probed,
      sshTarget,
      sshTunnelError,
      sshTunnelStarted,
    };
  } finally {
    if (tunnel) {
      try {
        await tunnel.stop();
      } catch {
        // Best-effort
      }
    }
  }
}
