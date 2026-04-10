import { describe, expect, it } from "vitest";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalBinding,
  matchSystemRunApprovalEnvHash,
  missingSystemRunApprovalBinding,
  normalizeSystemRunApprovalPlan,
} from "./system-run-approval-binding.js";

function expectOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result as T & { ok: true };
}

describe("normalizeSystemRunApprovalPlan", () => {
  it.each([
    {
      expected: {
        agentId: "main",
        argv: ["bash", "-lc", "echo hi"],
        commandPreview: "echo hi",
        commandText: 'bash -lc "echo hi"',
        cwd: "/tmp",
        mutableFileOperand: {
          argvIndex: 2,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
        sessionKey: "agent:main:main",
      },
      input: {
        agentId: " main ",
        argv: ["bash", "-lc", "echo hi"],
        commandPreview: "echo hi",
        commandText: 'bash -lc "echo hi"',
        cwd: " /tmp ",
        mutableFileOperand: {
          argvIndex: 2,
          path: " /tmp/payload.txt ",
          sha256: " abc123 ",
        },
        sessionKey: " agent:main:main ",
      },
      name: "accepts commandText and normalized mutable file operands",
    },
    {
      expected: {
        agentId: null,
        argv: ["bash", "-lc", "echo hi"],
        commandPreview: null,
        commandText: 'bash -lc "echo hi"',
        cwd: null,
        mutableFileOperand: undefined,
        sessionKey: null,
      },
      input: {
        argv: ["bash", "-lc", "echo hi"],
        rawCommand: 'bash -lc "echo hi"',
      },
      name: "falls back to rawCommand",
    },
  ])("$name", ({ input, expected }) => {
    expect(normalizeSystemRunApprovalPlan(input)).toEqual(expected);
  });

  it("rejects invalid file operands", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        mutableFileOperand: {
          argvIndex: -1,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
      }),
    ).toBeNull();
  });
});

describe("buildSystemRunApprovalEnvBinding", () => {
  it("normalizes, filters, and sorts env keys before hashing", () => {
    const normalized = buildSystemRunApprovalEnvBinding({
      " bad key ": "ignored",
      EMPTY: 1,
      alpha: "a",
      z_key: "b",
    });
    const reordered = buildSystemRunApprovalEnvBinding({
      alpha: "a",
      z_key: "b",
    });

    expect(normalized).toEqual({
      envHash: reordered.envHash,
      envKeys: ["alpha", "z_key"],
    });
    expect(normalized.envHash).toBeTypeOf("string");
    expect(normalized.envHash).toHaveLength(64);
  });

  it("returns a null hash when no usable env entries remain", () => {
    expect(buildSystemRunApprovalEnvBinding(null)).toEqual({
      envHash: null,
      envKeys: [],
    });
    expect(
      buildSystemRunApprovalEnvBinding({
        bad: 1,
      }),
    ).toEqual({
      envHash: null,
      envKeys: [],
    });
  });

  it("includes Windows-compatible override keys in env binding", () => {
    const base = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
    });
    const changed = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": String.raw`D:\SDKs`,
    });

    expect(base.envKeys).toEqual(["ProgramFiles(x86)"]);
    expect(base.envHash).toBeTypeOf("string");
    expect(base.envHash).not.toEqual(changed.envHash);
  });
});

describe("buildSystemRunApprovalBinding", () => {
  it("normalizes argv and metadata into a binding", () => {
    const envBinding = buildSystemRunApprovalEnvBinding({
      alpha: "1",
      beta: "2",
    });

    expect(
      buildSystemRunApprovalBinding({
        agentId: " main ",
        argv: ["bash", "-lc", 12],
        cwd: " /tmp ",
        env: {
          alpha: "1",
          beta: "2",
        },
        sessionKey: " agent:main:main ",
      }),
    ).toEqual({
      binding: {
        agentId: "main",
        argv: ["bash", "-lc", "12"],
        cwd: "/tmp",
        envHash: envBinding.envHash,
        sessionKey: "agent:main:main",
      },
      envKeys: ["alpha", "beta"],
    });
  });
});

describe("matchSystemRunApprovalEnvHash", () => {
  it.each([
    {
      expected: { ok: true },
      name: "accepts matching empty env bindings",
      params: {
        actualEnvHash: null,
        actualEnvKeys: [],
        expectedEnvHash: null,
      },
    },
    {
      expected: {
        code: "APPROVAL_ENV_BINDING_MISSING",
        details: { envKeys: ["ALPHA"] },
        message: "approval id missing env binding for requested env overrides",
        ok: false,
      },
      name: "reports missing approval env binding",
      params: {
        actualEnvHash: "abc",
        actualEnvKeys: ["ALPHA"],
        expectedEnvHash: null,
      },
    },
    {
      expected: {
        code: "APPROVAL_ENV_BINDING_MISSING",
        details: { envKeys: ["ProgramFiles(x86)"] },
        message: "approval id missing env binding for requested env overrides",
        ok: false,
      },
      name: "reports missing approval env binding when actual env keys are present without hashes",
      params: {
        actualEnvHash: null,
        actualEnvKeys: ["ProgramFiles(x86)"],
        expectedEnvHash: null,
      },
    },
    {
      expected: {
        code: "APPROVAL_ENV_MISMATCH",
        details: {
          actualEnvHash: "def",
          envKeys: ["ALPHA"],
          expectedEnvHash: "abc",
        },
        message: "approval id env binding mismatch",
        ok: false,
      },
      name: "reports env hash mismatches",
      params: {
        actualEnvHash: "def",
        actualEnvKeys: ["ALPHA"],
        expectedEnvHash: "abc",
      },
    },
  ])("$name", ({ params, expected }) => {
    expect(matchSystemRunApprovalEnvHash(params)).toEqual(expected);
  });
});

describe("matchSystemRunApprovalBinding", () => {
  const expected = {
    agentId: "main",
    argv: ["bash", "-lc", "echo hi"],
    cwd: "/tmp",
    envHash: "abc",
    sessionKey: "agent:main:main",
  };

  it("accepts exact matches", () => {
    expectOk(
      matchSystemRunApprovalBinding({
        actual: { ...expected },
        actualEnvKeys: ["ALPHA"],
        expected,
      }),
    );
  });

  it.each([
    {
      actual: { ...expected, argv: ["bash", "-lc", "echo bye"] },
      name: "argv mismatch",
    },
    {
      actual: { ...expected, cwd: "/var/tmp" },
      name: "cwd mismatch",
    },
    {
      actual: { ...expected, agentId: "other" },
      name: "agent mismatch",
    },
    {
      actual: { ...expected, sessionKey: "agent:main:other" },
      name: "session mismatch",
    },
  ])("rejects $name", ({ actual }) => {
    expect(
      matchSystemRunApprovalBinding({
        actual,
        actualEnvKeys: ["ALPHA"],
        expected,
      }),
    ).toEqual({
      code: "APPROVAL_REQUEST_MISMATCH",
      details: undefined,
      message: "approval id does not match request",
      ok: false,
    });
  });
});

describe("missingSystemRunApprovalBinding", () => {
  it("reports env keys with request mismatches", () => {
    expect(missingSystemRunApprovalBinding({ actualEnvKeys: ["ALPHA", "BETA"] })).toEqual({
      code: "APPROVAL_REQUEST_MISMATCH",
      details: {
        envKeys: ["ALPHA", "BETA"],
      },
      message: "approval id does not match request",
      ok: false,
    });
  });
});
