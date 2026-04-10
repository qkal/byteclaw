import { describe, expect, it } from "vitest";
import {
  parseAgentsListRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

describe("route-args", () => {
  it("parses health and status route args", () => {
    expect(
      parseHealthRouteArgs(["node", "openclaw", "health", "--json", "--timeout", "5000"]),
    ).toEqual({
      json: true,
      timeoutMs: 5000,
      verbose: false,
    });
    expect(
      parseStatusRouteArgs([
        "node",
        "openclaw",
        "status",
        "--json",
        "--deep",
        "--all",
        "--usage",
        "--timeout",
        "5000",
      ]),
    ).toEqual({
      all: true,
      deep: true,
      json: true,
      timeoutMs: 5000,
      usage: true,
      verbose: false,
    });
    expect(parseStatusRouteArgs(["node", "openclaw", "status", "--timeout"])).toBeNull();
  });

  it("parses gateway status route args and rejects probe-only ssh flags", () => {
    expect(
      parseGatewayStatusRouteArgs([
        "node",
        "openclaw",
        "gateway",
        "status",
        "--url",
        "ws://127.0.0.1:18789",
        "--token",
        "abc",
        "--password",
        "def",
        "--timeout",
        "5000",
        "--deep",
        "--require-rpc",
        "--json",
      ]),
    ).toEqual({
      deep: true,
      json: true,
      probe: true,
      requireRpc: true,
      rpc: {
        password: "def",
        timeout: "5000",
        token: "abc",
        url: "ws://127.0.0.1:18789",
      },
    });
    expect(
      parseGatewayStatusRouteArgs(["node", "openclaw", "gateway", "status", "--ssh", "host"]),
    ).toBeNull();
    expect(
      parseGatewayStatusRouteArgs(["node", "openclaw", "gateway", "status", "--ssh-auto"]),
    ).toBeNull();
  });

  it("parses sessions and agents list route args", () => {
    expect(
      parseSessionsRouteArgs([
        "node",
        "openclaw",
        "sessions",
        "--json",
        "--all-agents",
        "--agent",
        "default",
        "--store",
        "sqlite",
        "--active",
        "true",
      ]),
    ).toEqual({
      active: "true",
      agent: "default",
      allAgents: true,
      json: true,
      store: "sqlite",
    });
    expect(parseSessionsRouteArgs(["node", "openclaw", "sessions", "--agent"])).toBeNull();
    expect(
      parseAgentsListRouteArgs(["node", "openclaw", "agents", "list", "--json", "--bindings"]),
    ).toEqual({
      bindings: true,
      json: true,
    });
  });

  it("parses config routes", () => {
    expect(
      parseConfigGetRouteArgs([
        "node",
        "openclaw",
        "--log-level",
        "debug",
        "config",
        "get",
        "update.channel",
        "--json",
      ]),
    ).toEqual({
      json: true,
      path: "update.channel",
    });
    expect(
      parseConfigUnsetRouteArgs([
        "node",
        "openclaw",
        "config",
        "unset",
        "--profile",
        "work",
        "update.channel",
      ]),
    ).toEqual({
      path: "update.channel",
    });
    expect(parseConfigGetRouteArgs(["node", "openclaw", "config", "get", "--json"])).toBeNull();
  });

  it("parses models list and models status route args", () => {
    expect(
      parseModelsListRouteArgs([
        "node",
        "openclaw",
        "models",
        "list",
        "--provider",
        "openai",
        "--all",
        "--local",
        "--json",
        "--plain",
      ]),
    ).toEqual({
      all: true,
      json: true,
      local: true,
      plain: true,
      provider: "openai",
    });
    expect(
      parseModelsStatusRouteArgs([
        "node",
        "openclaw",
        "models",
        "status",
        "--probe-provider",
        "openai",
        "--probe-timeout",
        "5000",
        "--probe-concurrency",
        "2",
        "--probe-max-tokens",
        "64",
        "--probe-profile",
        "fast",
        "--probe-profile",
        "safe",
        "--agent",
        "default",
        "--json",
        "--plain",
        "--check",
        "--probe",
      ]),
    ).toEqual({
      agent: "default",
      check: true,
      json: true,
      plain: true,
      probe: true,
      probeConcurrency: "2",
      probeMaxTokens: "64",
      probeProfile: ["fast", "safe"],
      probeProvider: "openai",
      probeTimeout: "5000",
    });
    expect(
      parseModelsStatusRouteArgs(["node", "openclaw", "models", "status", "--probe-profile"]),
    ).toBeNull();
  });
});
