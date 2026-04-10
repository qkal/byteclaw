import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { gatherDaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";
import type { DaemonStatusOptions } from "./types.js";

export async function runDaemonStatus(opts: DaemonStatusOptions) {
  try {
    if (opts.requireRpc && !opts.probe) {
      defaultRuntime.error("Gateway status failed: --require-rpc cannot be used with --no-probe.");
      defaultRuntime.exit(1);
      return;
    }
    const status = await gatherDaemonStatus({
      deep: Boolean(opts.deep),
      probe: Boolean(opts.probe),
      requireRpc: Boolean(opts.requireRpc),
      rpc: opts.rpc,
    });
    printDaemonStatus(status, { json: Boolean(opts.json) });
    if (opts.requireRpc && !status.rpc?.ok) {
      defaultRuntime.exit(1);
    }
  } catch (error) {
    const rich = isRich();
    defaultRuntime.error(colorize(rich, theme.error, `Gateway status failed: ${String(error)}`));
    defaultRuntime.exit(1);
  }
}
