import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { vi } from "vitest";
import type { PluginRuntime } from "./runtime-api.js";
import { setMatrixRuntime } from "./runtime.js";

interface MatrixTestRuntimeOptions {
  cfg?: Record<string, unknown>;
  logging?: Partial<PluginRuntime["logging"]>;
  channel?: Partial<PluginRuntime["channel"]>;
  stateDir?: string;
}

export function installMatrixTestRuntime(options: MatrixTestRuntimeOptions = {}): void {
  const defaultStateDirResolver: NonNullable<PluginRuntime["state"]>["resolveStateDir"] = (
    _env,
    homeDir,
  ) => options.stateDir ?? (homeDir ?? (() => "/tmp"))();
  const logging: PluginRuntime["logging"] | undefined = options.logging
    ? ({
        getChildLogger: () => ({
          error: () => {},
          info: () => {},
          warn: () => {},
        }),
        shouldLogVerbose: () => false,
        ...options.logging,
      } as PluginRuntime["logging"])
    : undefined;

  setMatrixRuntime({
    config: {
      loadConfig: () => options.cfg ?? {},
    },
    ...(options.channel ? { channel: options.channel as PluginRuntime["channel"] } : {}),
    ...(logging ? { logging } : {}),
    state: {
      resolveStateDir: defaultStateDirResolver,
    },
  } as PluginRuntime);
}

type MatrixMonitorTestRuntimeOptions = Pick<MatrixTestRuntimeOptions, "cfg" | "stateDir"> & {
  matchesMentionPatterns?: (text: string, patterns: RegExp[]) => boolean;
  saveMediaBuffer?: NonNullable<NonNullable<PluginRuntime["channel"]>["media"]>["saveMediaBuffer"];
};

export function installMatrixMonitorTestRuntime(
  options: MatrixMonitorTestRuntimeOptions = {},
): void {
  installMatrixTestRuntime({
    cfg: options.cfg,
    channel: {
      media: {
        fetchRemoteMedia: vi.fn(),
        saveMediaBuffer: options.saveMediaBuffer ?? vi.fn(),
      },
      mentions: {
        buildMentionRegexes: () => [],
        implicitMentionKindWhen,
        matchesMentionPatterns:
          options.matchesMentionPatterns ??
          ((text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text))),
        matchesMentionWithExplicit: () => false,
        resolveInboundMentionDecision,
      },
    },
    stateDir: options.stateDir,
  });
}
