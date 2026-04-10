import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatAudienceType } from "./auth.js";
import type { getGoogleChatRuntime } from "./runtime.js";

export interface GoogleChatRuntimeEnv {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface GoogleChatMonitorOptions {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  webhookUrl?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

export type GoogleChatCoreRuntime = ReturnType<typeof getGoogleChatRuntime>;

export interface WebhookTarget {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  path: string;
  audienceType?: GoogleChatAudienceType;
  audience?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
}
