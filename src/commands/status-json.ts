import type { RuntimeEnv } from "../runtime.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

export async function statusJsonCommand(
  opts: {
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  await runStatusJsonCommand({
    includeSecurityAudit: opts.all === true,
    opts,
    runtime,
    scanStatusJsonFast,
    suppressHealthErrors: true,
  });
}
