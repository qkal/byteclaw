import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import "./test-helpers/fast-core-tools.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { callGatewayTool } from "./tools/gateway.js";

const { callGatewayToolMock, readGatewayCallOptionsMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  readGatewayCallOptionsMock: vi.fn(() => ({})),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: readGatewayCallOptionsMock,
}));

function requireGatewayTool(agentSessionKey?: string) {
  return createGatewayTool({
    ...(agentSessionKey ? { agentSessionKey } : {}),
    config: { commands: { restart: true } },
  });
}

function expectConfigMutationCall(params: {
  callGatewayTool: {
    mock: {
      calls: (readonly unknown[])[];
    };
  };
  action: "config.apply" | "config.patch";
  raw: string;
  sessionKey: string;
}) {
  expect(params.callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
  expect(params.callGatewayTool).toHaveBeenCalledWith(
    params.action,
    expect.any(Object),
    expect.objectContaining({
      baseHash: "hash-1",
      raw: params.raw.trim(),
      sessionKey: params.sessionKey,
    }),
  );
}

describe("gateway tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    readGatewayCallOptionsMock.mockClear();
    callGatewayToolMock.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
          hash: "hash-1",
        };
      }
      if (method === "config.schema.lookup") {
        return {
          children: [
            {
              hasChildren: false,
              hint: { label: "Token", sensitive: true },
              hintPath: "gateway.auth.token",
              key: "token",
              path: "gateway.auth.token",
              required: true,
              type: "string",
            },
          ],
          hint: { label: "Gateway Auth" },
          hintPath: "gateway.auth",
          path: "gateway.auth",
          schema: {
            type: "object",
          },
        };
      }
      return { ok: true };
    });
  });

  it("marks gateway as owner-only", async () => {
    const tool = requireGatewayTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("schedules SIGUSR1 restart", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));

    try {
      await withEnvAsync(
        { OPENCLAW_PROFILE: "isolated", OPENCLAW_STATE_DIR: stateDir },
        async () => {
          const tool = requireGatewayTool();

          const result = await tool.execute("call1", {
            action: "restart",
            delayMs: 0,
          });
          expect(result.details).toMatchObject({
            delayMs: 0,
            ok: true,
            pid: process.pid,
            signal: "SIGUSR1",
          });

          const sentinelPath = path.join(stateDir, "restart-sentinel.json");
          const raw = await fs.readFile(sentinelPath, "utf8");
          const parsed = JSON.parse(raw) as {
            payload?: { kind?: string; doctorHint?: string | null };
          };
          expect(parsed.payload?.kind).toBe("restart");
          expect(parsed.payload?.doctorHint).toBe(
            "Run: openclaw --profile isolated doctor --non-interactive",
          );

          expect(kill).not.toHaveBeenCalled();
          await vi.runAllTimersAsync();
          expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
        },
      );
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("passes config.apply through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw =
      '{\n  agents: { defaults: { workspace: "~/openclaw" } },\n  tools: { exec: { ask: "on-miss", security: "allowlist" } }\n}\n';
    await tool.execute("call2", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      action: "config.apply",
      callGatewayTool: vi.mocked(callGatewayTool),
      raw,
      sessionKey,
    });
  });

  it("passes config.patch through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    await tool.execute("call4", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      action: "config.patch",
      callGatewayTool: vi.mocked(callGatewayTool),
      raw,
      sessionKey,
    });
  });

  it("rejects config.patch when it changes exec approval settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { ask: "off" } } }',
      }),
    ).rejects.toThrow("gateway config.patch cannot change protected config paths: tools.exec.ask");
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it changes safe bin approval paths", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-safe-bins-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { safeBins: ["bash"], safeBinProfiles: { bash: { allowedValueFlags: ["-c"] } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.safeBins, tools.exec.safeBinProfiles",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("passes config.patch through gateway call when protected exec arrays and objects are unchanged", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                safeBinProfiles: {
                  bash: {
                    allowedValueFlags: ["-c"],
                  },
                },
                safeBinTrustedDirs: ["/tmp/openclaw-bin"],
                safeBins: ["bash"],
                security: "allowlist",
                strictInlineEval: true,
              },
            },
          },
          hash: "hash-1",
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool("agent:main:whatsapp:dm:+15555550123");

    const raw = `{
      tools: {
        exec: {
          safeBins: ["bash"],
          safeBinProfiles: {
            bash: {
              allowedValueFlags: ["-c"],
            },
          },
          safeBinTrustedDirs: ["/tmp/openclaw-bin"],
          strictInlineEval: true,
        },
      },
    }`;
    await tool.execute("call-same-protected-patch", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      action: "config.patch",
      callGatewayTool: vi.mocked(callGatewayTool),
      raw,
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });

  it("rejects config.patch when it changes strict inline eval directly", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { config: {}, hash: "hash-1" };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-inline-eval-direct", {
        action: "config.patch",
        raw: "{ tools: { exec: { strictInlineEval: false } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.strictInlineEval",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias changes strict inline eval", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { config: {}, hash: "hash-1" };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-protected-inline-eval", {
        action: "config.patch",
        raw: "{ tools: { bash: { strictInlineEval: false } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.strictInlineEval",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias changes exec security", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { config: {}, hash: "hash-1" };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { bash: { security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes exec security settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when protected exec settings are omitted", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-missing-protected", {
        action: "config.apply",
        raw: '{ agents: { defaults: { workspace: "~/openclaw" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.ask, tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes safe bin trusted directories", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-safe-bin-trust-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "allowlist", safeBinTrustedDirs: ["/tmp/openclaw-bin"] } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.safeBinTrustedDirs",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("passes update.run through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey,
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("returns a path-scoped schema lookup result", async () => {
    const tool = requireGatewayTool();

    const result = await tool.execute("call5", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.schema.lookup", expect.any(Object), {
      path: "gateway.auth",
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        children: [
          expect.objectContaining({
            hintPath: "gateway.auth.token",
            key: "token",
            path: "gateway.auth.token",
            required: true,
          }),
        ],
        hintPath: "gateway.auth",
        path: "gateway.auth",
      },
    });
    const schema = (result.details as { result?: { schema?: { properties?: unknown } } }).result
      ?.schema;
    expect(schema?.properties).toBeUndefined();
  });
});
