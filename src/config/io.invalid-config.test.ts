import { describe, expect, it, vi } from "vitest";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
  formatInvalidConfigLogMessage,
  logInvalidConfigOnce,
  throwInvalidConfig,
} from "./io.invalid-config.js";

describe("config io invalid config formatting", () => {
  it("formats issue details with sanitized paths and messages", () => {
    const details = formatInvalidConfigDetails([
      {
        message: 'Expected number\\nreceived "bad"',
        path: "gateway.port",
      },
      {
        message: "root problem",
        path: "",
      },
    ]);

    expect(details).toContain("- gateway.port:");
    expect(details).toContain("Expected number");
    expect(details).toContain("received");
    expect(details).toContain("- <root>: root problem");
  });

  it("formats the logger message with the escaped newline separator", () => {
    expect(formatInvalidConfigLogMessage("/tmp/openclaw.json", "- gateway.port: bad")).toBe(
      String.raw`Invalid config at /tmp/openclaw.json:\n- gateway.port: bad`,
    );
  });

  it("creates INVALID_CONFIG errors with inline details", () => {
    const err = createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: bad") as Error & {
      code?: string;
      details?: string;
    };

    expect(err.message).toBe("Invalid config at /tmp/openclaw.json:\n- gateway.port: bad");
    expect(err.code).toBe("INVALID_CONFIG");
    expect(err.details).toBe("- gateway.port: bad");
  });

  it("logs invalid config details only once per path", () => {
    const logger = { error: vi.fn() };
    const loggedConfigPaths = new Set<string>();

    logInvalidConfigOnce({
      configPath: "/tmp/openclaw.json",
      details: "- gateway.port: bad",
      loggedConfigPaths,
      logger,
    });
    logInvalidConfigOnce({
      configPath: "/tmp/openclaw.json",
      details: "- gateway.port: worse",
      loggedConfigPaths,
      logger,
    });

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      String.raw`Invalid config at /tmp/openclaw.json:\n- gateway.port: bad`,
    );
  });

  it("throws INVALID_CONFIG after logging the formatted details", () => {
    const logger = { error: vi.fn() };

    expect(() =>
      throwInvalidConfig({
        configPath: "/tmp/openclaw.json",
        issues: [{ message: "Unknown key(s): nope", path: "nope" }],
        loggedConfigPaths: new Set<string>(),
        logger,
      }),
    ).toThrowError("Invalid config at /tmp/openclaw.json:\n- nope: Unknown key(s): nope");
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
