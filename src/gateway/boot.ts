import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";

function generateBootSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `boot-${ts}-${suffix}`;
}

interface SessionMappingSnapshot {
  storePath: string;
  sessionKey: string;
  canRestore: boolean;
  hadEntry: boolean;
  entry?: SessionEntry;
}

const log = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";

export type BootRunResult =
  | { status: "skipped"; reason: "missing" | "empty" }
  | { status: "ran" }
  | { status: "failed"; reason: string };

function buildBootPrompt(content: string) {
  return [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "",
    "BOOT.md:",
    content,
    "",
    "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
    "Use the `target` field (not `to`) for message tool destinations.",
    `After sending with the message tool, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
    `If nothing needs attention, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
  ].join("\n");
}

async function loadBootFile(
  workspaceDir: string,
): Promise<{ content?: string; status: "ok" | "missing" | "empty" }> {
  const bootPath = path.join(workspaceDir, BOOT_FILENAME);
  try {
    const content = await fs.readFile(bootPath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty" };
    }
    return { content: trimmed, status: "ok" };
  } catch (error) {
    const anyErr = error as { code?: string };
    if (anyErr.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
}

function snapshotMainSessionMapping(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): SessionMappingSnapshot {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[params.sessionKey];
    if (!entry) {
      return {
        canRestore: true,
        hadEntry: false,
        sessionKey: params.sessionKey,
        storePath,
      };
    }
    return {
      canRestore: true,
      entry: structuredClone(entry),
      hadEntry: true,
      sessionKey: params.sessionKey,
      storePath,
    };
  } catch (error) {
    log.debug("boot: could not snapshot main session mapping", {
      error: String(error),
      sessionKey: params.sessionKey,
    });
    return {
      canRestore: false,
      hadEntry: false,
      sessionKey: params.sessionKey,
      storePath,
    };
  }
}

async function restoreMainSessionMapping(
  snapshot: SessionMappingSnapshot,
): Promise<string | undefined> {
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    await updateSessionStore(
      snapshot.storePath,
      (store) => {
        if (snapshot.hadEntry && snapshot.entry) {
          store[snapshot.sessionKey] = snapshot.entry;
          return;
        }
        delete store[snapshot.sessionKey];
      },
      { activeSessionKey: snapshot.sessionKey },
    );
    return undefined;
  } catch (error) {
    return formatErrorMessage(error);
  }
}

export async function runBootOnce(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  workspaceDir: string;
  agentId?: string;
}): Promise<BootRunResult> {
  const bootRuntime: RuntimeEnv = {
    error: (message) => log.error(String(message)),
    exit: defaultRuntime.exit,
    log: () => {},
  };
  let result: Awaited<ReturnType<typeof loadBootFile>>;
  try {
    result = await loadBootFile(params.workspaceDir);
  } catch (error) {
    const message = formatErrorMessage(error);
    log.error(`boot: failed to read ${BOOT_FILENAME}: ${message}`);
    return { reason: message, status: "failed" };
  }

  if (result.status === "missing" || result.status === "empty") {
    return { reason: result.status, status: "skipped" };
  }

  const sessionKey = params.agentId
    ? resolveAgentMainSessionKey({ agentId: params.agentId, cfg: params.cfg })
    : resolveMainSessionKey(params.cfg);
  const message = buildBootPrompt(result.content ?? "");
  const sessionId = generateBootSessionId();
  const mappingSnapshot = snapshotMainSessionMapping({
    cfg: params.cfg,
    sessionKey,
  });

  let agentFailure: string | undefined;
  try {
    await agentCommand(
      {
        deliver: false,
        message,
        senderIsOwner: true,
        sessionId,
        sessionKey,
      },
      bootRuntime,
      params.deps,
    );
  } catch (error) {
    agentFailure = formatErrorMessage(error);
    log.error(`boot: agent run failed: ${agentFailure}`);
  }

  const mappingRestoreFailure = await restoreMainSessionMapping(mappingSnapshot);
  if (mappingRestoreFailure) {
    log.error(`boot: failed to restore main session mapping: ${mappingRestoreFailure}`);
  }

  if (!agentFailure && !mappingRestoreFailure) {
    return { status: "ran" };
  }
  const reasonParts = [
    agentFailure ? `agent run failed: ${agentFailure}` : undefined,
    mappingRestoreFailure ? `mapping restore failed: ${mappingRestoreFailure}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return { reason: reasonParts.join("; "), status: "failed" };
}
