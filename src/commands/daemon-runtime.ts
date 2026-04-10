export type GatewayDaemonRuntime = "node" | "bun";

export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

export const GATEWAY_DAEMON_RUNTIME_OPTIONS: {
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}[] = [
  {
    hint: "Required for WhatsApp + Telegram. Bun can corrupt memory on reconnect.",
    label: "Node (recommended)",
    value: "node",
  },
];

export function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime {
  return value === "node" || value === "bun";
}
