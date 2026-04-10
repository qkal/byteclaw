import { describe, expect, it } from "vitest";
import {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "./install-mode-options.js";

type LoggerKey = "default" | "explicit";

describe("install mode option helpers", () => {
  it.each([
    {
      expected: { dryRun: false, loggerKey: "default", mode: "install" },
      name: "applies logger, mode, and dryRun defaults",
      params: {},
    },
    {
      expected: { dryRun: true, loggerKey: "explicit", mode: "update" },
      name: "preserves explicit mode and dryRun values",
      params: { dryRun: true, loggerKey: "explicit", mode: "update" as const },
    },
    {
      expected: { dryRun: false, loggerKey: "default", mode: "update" },
      name: "preserves explicit false dryRun values",
      params: { dryRun: false, mode: "update" as const },
    },
  ] satisfies {
    name: string;
    params: { loggerKey?: LoggerKey; mode?: "install" | "update"; dryRun?: boolean };
    expected: { loggerKey: LoggerKey; mode: "install" | "update"; dryRun: boolean };
  }[])("$name", ({ params, expected }) => {
    const loggers = {
      default: { warn: (_message: string) => {} },
      explicit: { warn: (_message: string) => {} },
    } satisfies Record<LoggerKey, { warn: (_message: string) => void }>;

    expect(
      resolveInstallModeOptions(
        {
          dryRun: params.dryRun,
          logger: params.loggerKey ? loggers[params.loggerKey] : undefined,
          mode: params.mode,
        },
        loggers.default,
      ),
    ).toEqual({
      dryRun: expected.dryRun,
      logger: loggers[expected.loggerKey],
      mode: expected.mode,
    });
  });

  it.each([
    {
      defaultTimeoutMs: undefined,
      expectedDryRun: false,
      expectedMode: "install",
      expectedTimeoutMs: 120_000,
      name: "uses default timeout when not provided",
      params: {},
    },
    {
      defaultTimeoutMs: 5000,
      expectedDryRun: false,
      expectedMode: "install",
      expectedTimeoutMs: 5000,
      name: "honors custom timeout default override",
      params: {},
    },
    {
      defaultTimeoutMs: 5000,
      expectedDryRun: true,
      expectedMode: "update",
      expectedTimeoutMs: 0,
      name: "preserves explicit timeout values",
      params: { dryRun: true, mode: "update" as const, timeoutMs: 0 },
    },
  ])("$name", ({ params, defaultTimeoutMs, expectedTimeoutMs, expectedMode, expectedDryRun }) => {
    const logger = { warn: (_message: string) => {} };
    const result = resolveTimedInstallModeOptions(params, logger, defaultTimeoutMs);

    expect(result.timeoutMs).toBe(expectedTimeoutMs);
    expect(result.mode).toBe(expectedMode);
    expect(result.dryRun).toBe(expectedDryRun);
    expect(result.logger).toBe(logger);
  });
});
