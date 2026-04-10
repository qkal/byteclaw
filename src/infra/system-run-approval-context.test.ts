import { describe, expect, test } from "vitest";
import {
  parsePreparedSystemRunPayload,
  resolveSystemRunApprovalRequestContext,
  resolveSystemRunApprovalRuntimeContext,
} from "./system-run-approval-context.js";

describe("resolveSystemRunApprovalRequestContext", () => {
  test.each([
    {
      expected: {
        commandArgv: ["./env", "sh", "-c", "jq --version"],
        commandPreview: "jq --version",
        commandText: './env sh -c "jq --version"',
      },
      name: "uses full approval text and separate preview for node system.run plans",
      params: {
        command: "jq --version",
        host: "node",
        systemRunPlan: {
          agentId: "main",
          argv: ["./env", "sh", "-c", "jq --version"],
          commandPreview: "jq --version",
          commandText: './env sh -c "jq --version"',
          cwd: "/tmp",
          sessionKey: "agent:main:main",
        },
      },
    },
    {
      expected: {
        commandPreview: "jq --version",
        commandText: './env sh -c "jq --version"',
      },
      name: "derives preview from fallback command for older node plans",
      params: {
        command: "jq --version",
        host: "node",
        systemRunPlan: {
          agentId: "main",
          argv: ["./env", "sh", "-c", "jq --version"],
          cwd: "/tmp",
          rawCommand: './env sh -c "jq --version"',
          sessionKey: "agent:main:main",
        },
      },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveSystemRunApprovalRequestContext(params)).toMatchObject(expected);
  });

  test("falls back to explicit request params for non-node hosts", () => {
    const context = resolveSystemRunApprovalRequestContext({
      agentId: "main",
      command: "jq --version",
      commandArgv: ["jq", "--version"],
      cwd: "/tmp",
      host: "gateway",
      sessionKey: "agent:main:main",
      systemRunPlan: {
        argv: ["ignored"],
        commandText: "ignored",
      },
    });

    expect(context.plan).toBeNull();
    expect(context.commandArgv).toEqual(["jq", "--version"]);
    expect(context.commandText).toBe("jq --version");
    expect(context.commandPreview).toBeNull();
    expect(context.cwd).toBe("/tmp");
    expect(context.agentId).toBe("main");
    expect(context.sessionKey).toBe("agent:main:main");
  });
});

describe("parsePreparedSystemRunPayload", () => {
  test("parses legacy prepared payloads via top-level fallback command text", () => {
    expect(
      parsePreparedSystemRunPayload({
        commandText: 'bash -lc "jq --version"',
        plan: {
          agentId: "main",
          argv: ["bash", "-lc", "jq --version"],
          cwd: "/tmp",
          sessionKey: "agent:main:main",
        },
      }),
    ).toEqual({
      plan: {
        agentId: "main",
        argv: ["bash", "-lc", "jq --version"],
        commandPreview: null,
        commandText: 'bash -lc "jq --version"',
        cwd: "/tmp",
        sessionKey: "agent:main:main",
      },
    });
  });

  test("rejects legacy payloads missing argv or command text", () => {
    expect(parsePreparedSystemRunPayload({ commandText: "jq --version", plan: { argv: [] } })).toBe(
      null,
    );
    expect(
      parsePreparedSystemRunPayload({
        plan: { argv: ["jq", "--version"] },
      }),
    ).toBeNull();
  });
});

describe("resolveSystemRunApprovalRuntimeContext", () => {
  test.each([
    {
      expected: {
        agentId: "main",
        argv: ["jq", "--version"],
        commandText: "jq --version",
        cwd: "/tmp",
        ok: true,
        plan: {
          agentId: "main",
          argv: ["jq", "--version"],
          commandPreview: "jq --version",
          commandText: "jq --version",
          cwd: "/tmp",
          sessionKey: "agent:main:main",
        },
        sessionKey: "agent:main:main",
      },
      name: "uses normalized plan runtime metadata when available",
      params: {
        plan: {
          agentId: "main",
          argv: ["jq", "--version"],
          commandPreview: "jq --version",
          commandText: "jq --version",
          cwd: "/tmp",
          sessionKey: "agent:main:main",
        },
      },
    },
    {
      expected: {
        agentId: "main",
        argv: ["bash", "-lc", "jq --version"],
        commandText: 'bash -lc "jq --version"',
        cwd: "/tmp",
        ok: true,
        plan: null,
        sessionKey: "agent:main:main",
      },
      name: "falls back to command/rawCommand validation without a plan",
      params: {
        agentId: "main",
        command: ["bash", "-lc", "jq --version"],
        cwd: "/tmp",
        rawCommand: 'bash -lc "jq --version"',
        sessionKey: "agent:main:main",
      },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveSystemRunApprovalRuntimeContext(params)).toEqual(expected);
  });

  test("returns request validation errors from command fallback", () => {
    expect(
      resolveSystemRunApprovalRuntimeContext({
        rawCommand: "jq --version",
      }),
    ).toEqual({
      details: { code: "MISSING_COMMAND" },
      message: "rawCommand requires params.command",
      ok: false,
    });
  });
});
