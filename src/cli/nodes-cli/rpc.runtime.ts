import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { withProgress } from "../progress.js";
import type { NodesRpcOpts } from "./types.js";

export async function callGatewayCliRuntime(
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
  callOpts?: { transportTimeoutMs?: number },
) {
  return await withProgress(
    {
      enabled: opts.json !== true,
      indeterminate: true,
      label: `Nodes ${method}`,
    },
    async () =>
      await callGateway({
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        method,
        mode: GATEWAY_CLIENT_MODES.CLI,
        params,
        timeoutMs: callOpts?.transportTimeoutMs ?? Number(opts.timeout ?? 10_000),
        token: opts.token,
        url: opts.url,
      }),
  );
}
