import type { SlackMonitorContext } from "../context.js";

export type SlackSystemEventHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

export interface SlackSystemEventTestOverrides {
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  channelType?: "im" | "channel";
  channelUsers?: string[];
}

export function createSlackSystemEventTestHarness(overrides?: SlackSystemEventTestOverrides) {
  const handlers: Record<string, SlackSystemEventHandler> = {};
  const channelType = overrides?.channelType ?? "im";
  const app = {
    event: (name: string, handler: SlackSystemEventHandler) => {
      handlers[name] = handler;
    },
  };
  const ctx = {
    allowFrom: overrides?.allowFrom ?? [],
    allowNameMatching: false,
    app,
    channelsConfig: overrides?.channelUsers
      ? {
          C1: {
            enabled: true,
            users: overrides.channelUsers,
          },
        }
      : undefined,
    defaultRequireMention: true,
    dmEnabled: true,
    dmPolicy: overrides?.dmPolicy ?? "open",
    groupPolicy: "open",
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({
      name: channelType === "im" ? "direct" : "general",
      type: channelType,
    }),
    resolveSlackSystemEventSessionKey: () => "agent:main:main",
    resolveUserName: async () => ({ name: "alice" }),
    runtime: { error: () => {} },
    shouldDropMismatchedSlackEvent: () => false,
  } as unknown as SlackMonitorContext;

  return {
    ctx,
    getHandler(name: string): SlackSystemEventHandler | null {
      return handlers[name] ?? null;
    },
  };
}
