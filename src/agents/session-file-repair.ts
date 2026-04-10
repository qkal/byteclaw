import fs from "node:fs/promises";
import path from "node:path";

interface RepairReport {
  repaired: boolean;
  droppedLines: number;
  backupPath?: string;
  reason?: string;
}

function isSessionHeader(entry: unknown): entry is { type: string; id: string } {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}

export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { droppedLines: 0, reason: "missing session file", repaired: false };
  }

  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return { droppedLines: 0, reason: "missing session file", repaired: false };
    }
    const reason = `failed to read session file: ${error instanceof Error ? error.message : "unknown error"}`;
    params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
    return { droppedLines: 0, reason, repaired: false };
  }

  const lines = content.split(/\r?\n/);
  const entries: unknown[] = [];
  let droppedLines = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
      droppedLines += 1;
    }
  }

  if (entries.length === 0) {
    return { droppedLines, reason: "empty session file", repaired: false };
  }

  if (!isSessionHeader(entries[0])) {
    params.warn?.(
      `session file repair skipped: invalid session header (${path.basename(sessionFile)})`,
    );
    return { droppedLines, reason: "invalid session header", repaired: false };
  }

  if (droppedLines === 0) {
    return { droppedLines: 0, repaired: false };
  }

  const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  const tmpPath = `${sessionFile}.repair-${process.pid}-${Date.now()}.tmp`;
  try {
    const stat = await fs.stat(sessionFile).catch(() => null);
    await fs.writeFile(backupPath, content, "utf8");
    if (stat) {
      await fs.chmod(backupPath, stat.mode);
    }
    await fs.writeFile(tmpPath, cleaned, "utf8");
    if (stat) {
      await fs.chmod(tmpPath, stat.mode);
    }
    await fs.rename(tmpPath, sessionFile);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch (error) {
      params.warn?.(
        `session file repair cleanup failed: ${error instanceof Error ? error.message : "unknown error"} (${path.basename(
          tmpPath,
        )})`,
      );
    }
    return {
      droppedLines,
      reason: `repair failed: ${error instanceof Error ? error.message : "unknown error"}`,
      repaired: false,
    };
  }

  params.warn?.(
    `session file repaired: dropped ${droppedLines} malformed line(s) (${path.basename(
      sessionFile,
    )})`,
  );
  return { backupPath, droppedLines, repaired: true };
}
