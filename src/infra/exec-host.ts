import crypto from "node:crypto";
import { requestJsonlSocket } from "./jsonl-socket.js";

export interface ExecHostRequest {
  command: string[];
  rawCommand?: string | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approvalDecision?: "allow-once" | "allow-always" | null;
}

export interface ExecHostRunResult {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
}

export interface ExecHostError {
  code: string;
  message: string;
  reason?: string;
}

export type ExecHostResponse =
  | { ok: true; payload: ExecHostRunResult }
  | { ok: false; error: ExecHostError };

export async function requestExecHostViaSocket(params: {
  socketPath: string;
  token: string;
  request: ExecHostRequest;
  timeoutMs?: number;
}): Promise<ExecHostResponse | null> {
  const { socketPath, token, request } = params;
  if (!socketPath || !token) {
    return null;
  }
  const timeoutMs = params.timeoutMs ?? 20_000;
  const requestJson = JSON.stringify(request);
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now();
  const hmac = crypto
    .createHmac("sha256", token)
    .update(`${nonce}:${ts}:${requestJson}`)
    .digest("hex");
  const payload = JSON.stringify({
    hmac,
    id: crypto.randomUUID(),
    nonce,
    requestJson,
    ts,
    type: "exec",
  });

  return await requestJsonlSocket({
    accept: (value) => {
      const msg = value as { type?: string; ok?: boolean; payload?: unknown; error?: unknown };
      if (msg?.type !== "exec-res") {
        return undefined;
      }
      if (msg.ok === true && msg.payload) {
        return { ok: true, payload: msg.payload as ExecHostRunResult };
      }
      if (msg.ok === false && msg.error) {
        return { error: msg.error as ExecHostError, ok: false };
      }
      return null;
    },
    requestLine: payload,
    socketPath,
    timeoutMs,
  });
}
