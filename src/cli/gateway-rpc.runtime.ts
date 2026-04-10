import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { withProgress } from "./progress.js";

export async function callGatewayFromCliRuntime(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: { expectFinal?: boolean; progress?: boolean },
) {
  const showProgress = extra?.progress ?? opts.json !== true;
  return await withProgress(
    {
      enabled: showProgress,
      indeterminate: true,
      label: `Gateway ${method}`,
    },
    async () =>
      await callGateway({
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
        method,
        mode: GATEWAY_CLIENT_MODES.CLI,
        params,
        timeoutMs: Number(opts.timeout ?? 10_000),
        token: opts.token,
        url: opts.url,
      }),
  );
}
