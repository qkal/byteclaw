import crypto from "node:crypto";
import type {
  SystemRunApprovalBinding,
  SystemRunApprovalFileOperand,
  SystemRunApprovalPlan,
} from "./exec-approvals.js";
import { normalizeHostOverrideEnvVarKey } from "./host-env-security.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

type NormalizedSystemRunEnvEntry = [key: string, value: string];

function normalizeSystemRunApprovalFileOperand(
  value: unknown,
): SystemRunApprovalFileOperand | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const argvIndex =
    typeof candidate.argvIndex === "number" &&
    Number.isInteger(candidate.argvIndex) &&
    candidate.argvIndex >= 0
      ? candidate.argvIndex
      : null;
  const filePath = normalizeNonEmptyString(candidate.path);
  const sha256 = normalizeNonEmptyString(candidate.sha256);
  if (argvIndex === null || !filePath || !sha256) {
    return null;
  }
  return {
    argvIndex,
    path: filePath,
    sha256,
  };
}

export function normalizeSystemRunApprovalPlan(value: unknown): SystemRunApprovalPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const argv = normalizeStringArray(candidate.argv);
  if (argv.length === 0) {
    return null;
  }
  const mutableFileOperand = normalizeSystemRunApprovalFileOperand(candidate.mutableFileOperand);
  if (candidate.mutableFileOperand !== undefined && mutableFileOperand === null) {
    return null;
  }
  const commandText =
    normalizeNonEmptyString(candidate.commandText) ?? normalizeNonEmptyString(candidate.rawCommand);
  if (!commandText) {
    return null;
  }
  return {
    agentId: normalizeNonEmptyString(candidate.agentId),
    argv,
    commandPreview: normalizeNonEmptyString(candidate.commandPreview),
    commandText,
    cwd: normalizeNonEmptyString(candidate.cwd),
    mutableFileOperand: mutableFileOperand ?? undefined,
    sessionKey: normalizeNonEmptyString(candidate.sessionKey),
  };
}

function normalizeSystemRunEnvEntries(env: unknown): NormalizedSystemRunEnvEntry[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return [];
  }
  const entries: NormalizedSystemRunEnvEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(env as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const key = normalizeHostOverrideEnvVarKey(rawKey);
    if (!key) {
      continue;
    }
    entries.push([key, rawValue]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries;
}

function hashSystemRunEnvEntries(entries: NormalizedSystemRunEnvEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function buildSystemRunApprovalEnvBinding(env: unknown): {
  envHash: string | null;
  envKeys: string[];
} {
  const entries = normalizeSystemRunEnvEntries(env);
  return {
    envHash: hashSystemRunEnvEntries(entries),
    envKeys: entries.map(([key]) => key),
  };
}

export function buildSystemRunApprovalBinding(params: {
  argv: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  env?: unknown;
}): { binding: SystemRunApprovalBinding; envKeys: string[] } {
  const envBinding = buildSystemRunApprovalEnvBinding(params.env);
  return {
    binding: {
      agentId: normalizeNonEmptyString(params.agentId),
      argv: normalizeStringArray(params.argv),
      cwd: normalizeNonEmptyString(params.cwd),
      envHash: envBinding.envHash,
      sessionKey: normalizeNonEmptyString(params.sessionKey),
    },
    envKeys: envBinding.envKeys,
  };
}

function argvMatches(expectedArgv: string[], actualArgv: string[]): boolean {
  if (expectedArgv.length === 0 || expectedArgv.length !== actualArgv.length) {
    return false;
  }
  for (let i = 0; i < expectedArgv.length; i += 1) {
    if (expectedArgv[i] !== actualArgv[i]) {
      return false;
    }
  }
  return true;
}

export type SystemRunApprovalMatchResult =
  | { ok: true }
  | {
      ok: false;
      code: "APPROVAL_REQUEST_MISMATCH" | "APPROVAL_ENV_BINDING_MISSING" | "APPROVAL_ENV_MISMATCH";
      message: string;
      details?: Record<string, unknown>;
    };

type SystemRunApprovalMismatch = Extract<SystemRunApprovalMatchResult, { ok: false }>;

const APPROVAL_REQUEST_MISMATCH_MESSAGE = "approval id does not match request";

function requestMismatch(details?: Record<string, unknown>): SystemRunApprovalMatchResult {
  return {
    code: "APPROVAL_REQUEST_MISMATCH",
    details,
    message: APPROVAL_REQUEST_MISMATCH_MESSAGE,
    ok: false,
  };
}

export function matchSystemRunApprovalEnvHash(params: {
  expectedEnvHash: string | null;
  actualEnvHash: string | null;
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  // Fail closed if callers provide inconsistent hash/key state. This guards against
  // Normalization drift between approval and execution paths.
  if (!params.expectedEnvHash && !params.actualEnvHash && params.actualEnvKeys.length > 0) {
    return {
      code: "APPROVAL_ENV_BINDING_MISSING",
      details: { envKeys: params.actualEnvKeys },
      message: "approval id missing env binding for requested env overrides",
      ok: false,
    };
  }
  if (!params.expectedEnvHash && !params.actualEnvHash) {
    return { ok: true };
  }
  if (!params.expectedEnvHash && params.actualEnvHash) {
    return {
      code: "APPROVAL_ENV_BINDING_MISSING",
      details: { envKeys: params.actualEnvKeys },
      message: "approval id missing env binding for requested env overrides",
      ok: false,
    };
  }
  if (params.expectedEnvHash !== params.actualEnvHash) {
    return {
      code: "APPROVAL_ENV_MISMATCH",
      details: {
        actualEnvHash: params.actualEnvHash,
        envKeys: params.actualEnvKeys,
        expectedEnvHash: params.expectedEnvHash,
      },
      message: "approval id env binding mismatch",
      ok: false,
    };
  }
  return { ok: true };
}

export function matchSystemRunApprovalBinding(params: {
  expected: SystemRunApprovalBinding;
  actual: SystemRunApprovalBinding;
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  if (!argvMatches(params.expected.argv, params.actual.argv)) {
    return requestMismatch();
  }
  if (params.expected.cwd !== params.actual.cwd) {
    return requestMismatch();
  }
  if (params.expected.agentId !== params.actual.agentId) {
    return requestMismatch();
  }
  if (params.expected.sessionKey !== params.actual.sessionKey) {
    return requestMismatch();
  }
  return matchSystemRunApprovalEnvHash({
    actualEnvHash: params.actual.envHash,
    actualEnvKeys: params.actualEnvKeys,
    expectedEnvHash: params.expected.envHash,
  });
}

export function missingSystemRunApprovalBinding(params: {
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  return requestMismatch({
    envKeys: params.actualEnvKeys,
  });
}

export function toSystemRunApprovalMismatchError(params: {
  runId: string;
  match: SystemRunApprovalMismatch;
}): { ok: false; message: string; details: Record<string, unknown> } {
  const details: Record<string, unknown> = {
    code: params.match.code,
    runId: params.runId,
  };
  if (params.match.details) {
    Object.assign(details, params.match.details);
  }
  return {
    details,
    message: params.match.message,
    ok: false,
  };
}
