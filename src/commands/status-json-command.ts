import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

export interface StatusJsonCommandOptions {
  deep?: boolean;
  usage?: boolean;
  timeoutMs?: number;
  all?: boolean;
}

export async function runStatusJsonCommand(params: {
  opts: StatusJsonCommandOptions;
  runtime: RuntimeEnv;
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
  scanStatusJsonFast: (
    opts: { timeoutMs?: number; all?: boolean },
    runtime: RuntimeEnv,
  ) => Promise<Parameters<typeof resolveStatusJsonOutput>[0]["scan"]>;
}) {
  const scan = await params.scanStatusJsonFast(
    { all: params.opts.all, timeoutMs: params.opts.timeoutMs },
    params.runtime,
  );
  writeRuntimeJson(
    params.runtime,
    await resolveStatusJsonOutput({
      includePluginCompatibility: params.includePluginCompatibility,
      includeSecurityAudit: params.includeSecurityAudit,
      opts: params.opts,
      scan,
      suppressHealthErrors: params.suppressHealthErrors,
    }),
  );
}
