import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import type { getBlueBubblesRuntime } from "./runtime.js";
export {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookPath,
  resolveWebhookPathFromConfig,
} from "./webhook-shared.js";

export interface BlueBubblesRuntimeEnv {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface BlueBubblesMonitorOptions {
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  webhookPath?: string;
}

export type BlueBubblesCoreRuntime = ReturnType<typeof getBlueBubblesRuntime>;

export interface WebhookTarget {
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  core: BlueBubblesCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}
