import { spawn } from 'node:child_process';
import { normalizeOptionalLowercaseString } from '../shared/string-coerce.js';
import { formatErrorMessage } from './errors.js';
import { triggerOpenClawRestart } from './restart.js';
import { detectRespawnSupervisor } from './supervisor-markers.js';

type RespawnMode = 'spawned' | 'supervised' | 'disabled' | 'failed';

export interface GatewayRespawnResult {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
export function restartGatewayProcessWithFreshPid(): GatewayRespawnResult {
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: 'disabled' };
  }
  const supervisor = detectRespawnSupervisor(process.env);
  if (supervisor) {
    // On macOS launchd, exit cleanly and let KeepAlive relaunch the service.
    // Avoid detached kickstart/start handoffs here so restart timing stays tied
    // To launchd's native supervision rather than a second helper process.
    if (supervisor === 'schtasks') {
      const restart = triggerOpenClawRestart();
      if (!restart.ok) {
        return {
          detail: restart.detail ?? `${restart.method} restart failed`,
          mode: 'failed',
        };
      }
    }
    return { mode: 'supervised' };
  }
  if (process.platform === 'win32') {
    // Detached respawn is unsafe on Windows without an identified Scheduled Task:
    // The child becomes orphaned if the original process exits.
    return {
      detail:
        'win32: detached respawn unsupported without Scheduled Task markers',
      mode: 'disabled',
    };
  }

  try {
    const args = [...process.execArgv, ...process.argv.slice(1)];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([_, v]) => v !== undefined),
    ) as Record<string, string>;
    const child = spawn(process.execPath, args, {
      detached: true,
      env,
      stdio: 'inherit' as const,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (child as any).unref();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { mode: 'spawned', pid: (child as any).pid ?? undefined };
  } catch (error) {
    const detail = formatErrorMessage(error);
    return { detail, mode: 'failed' };
  }
}
