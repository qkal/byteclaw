import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";

export function createTranscriptFixtureSync(params: {
  prefix: string;
  sessionId: string;
  fileName?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const transcriptPath = path.join(dir, params.fileName ?? "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      cwd: "/tmp",
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      type: "session",
      version: CURRENT_SESSION_VERSION,
    })}\n`,
    "utf8",
  );
  return { dir, transcriptPath };
}

export function createMockSessionEntry(params: {
  transcriptPath: string;
  sessionId: string;
  canonicalKey?: string;
  cfg?: Record<string, unknown>;
}) {
  return {
    canonicalKey: params.canonicalKey ?? "main",
    cfg: params.cfg ?? {},
    entry: {
      sessionFile: params.transcriptPath,
      sessionId: params.sessionId,
    },
    storePath: path.join(path.dirname(params.transcriptPath), "sessions.json"),
  };
}
