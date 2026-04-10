import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSessionFilePath } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export function forkSessionFromParentRuntime(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
    { agentId: params.agentId, sessionsDir: params.sessionsDir },
  );
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
    return null;
  }
  try {
    const manager = SessionManager.open(parentSessionFile);
    const leafId = manager.getLeafId();
    if (leafId) {
      const sessionFile = manager.createBranchedSession(leafId) ?? manager.getSessionFile();
      const sessionId = manager.getSessionId();
      if (sessionFile && sessionId) {
        return { sessionFile, sessionId };
      }
    }
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(manager.getSessionDir(), `${fileTimestamp}_${sessionId}.jsonl`);
    const header = {
      cwd: manager.getCwd(),
      id: sessionId,
      parentSession: parentSessionFile,
      timestamp,
      type: "session",
      version: CURRENT_SESSION_VERSION,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { sessionFile, sessionId };
  } catch {
    return null;
  }
}
