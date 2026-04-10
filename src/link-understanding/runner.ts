import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { LinkModelConfig, LinkToolsConfig } from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { CLI_OUTPUT_MAX_BUFFER } from "../media-understanding/defaults.js";
import { resolveTimeoutMs } from "../media-understanding/resolve.js";
import {
  normalizeMediaUnderstandingChatType,
  resolveMediaUnderstandingScope,
} from "../media-understanding/scope.js";
import { runExec } from "../process/exec.js";
import { DEFAULT_LINK_TIMEOUT_SECONDS } from "./defaults.js";
import { extractLinksFromMessage } from "./detect.js";

export interface LinkUnderstandingResult {
  urls: string[];
  outputs: string[];
}

function resolveScopeDecision(params: {
  config?: LinkToolsConfig;
  ctx: MsgContext;
}): "allow" | "deny" {
  return resolveMediaUnderstandingScope({
    channel: params.ctx.Surface ?? params.ctx.Provider,
    chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType),
    scope: params.config?.scope,
    sessionKey: params.ctx.SessionKey,
  });
}

function resolveTimeoutMsFromConfig(params: {
  config?: LinkToolsConfig;
  entry: LinkModelConfig;
}): number {
  const configured = params.entry.timeoutSeconds ?? params.config?.timeoutSeconds;
  return resolveTimeoutMs(configured, DEFAULT_LINK_TIMEOUT_SECONDS);
}

async function runCliEntry(params: {
  entry: LinkModelConfig;
  ctx: MsgContext;
  url: string;
  config?: LinkToolsConfig;
}): Promise<string | null> {
  if ((params.entry.type ?? "cli") !== "cli") {
    return null;
  }
  const command = params.entry.command.trim();
  if (!command) {
    return null;
  }
  const args = params.entry.args ?? [];
  const timeoutMs = resolveTimeoutMsFromConfig({ config: params.config, entry: params.entry });
  const templCtx = {
    ...params.ctx,
    LinkUrl: params.url,
  };
  const argv = [command, ...args].map((part, index) =>
    index === 0 ? part : applyTemplate(part, templCtx),
  );

  if (shouldLogVerbose()) {
    logVerbose(`Link understanding via CLI: ${argv.join(" ")}`);
  }

  const { stdout } = await runExec(argv[0], argv.slice(1), {
    maxBuffer: CLI_OUTPUT_MAX_BUFFER,
    timeoutMs,
  });
  const trimmed = stdout.trim();
  return trimmed || null;
}

async function runLinkEntries(params: {
  entries: LinkModelConfig[];
  ctx: MsgContext;
  url: string;
  config?: LinkToolsConfig;
}): Promise<string | null> {
  let lastError: unknown;
  for (const entry of params.entries) {
    try {
      const output = await runCliEntry({
        config: params.config,
        ctx: params.ctx,
        entry,
        url: params.url,
      });
      if (output) {
        return output;
      }
    } catch (error) {
      lastError = error;
      if (shouldLogVerbose()) {
        logVerbose(`Link understanding failed for ${params.url}: ${String(error)}`);
      }
    }
  }
  if (lastError && shouldLogVerbose()) {
    logVerbose(`Link understanding exhausted for ${params.url}`);
  }
  return null;
}

export async function runLinkUnderstanding(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  message?: string;
}): Promise<LinkUnderstandingResult> {
  const config = params.cfg.tools?.links;
  if (!config || config.enabled === false) {
    return { outputs: [], urls: [] };
  }

  const scopeDecision = resolveScopeDecision({ config, ctx: params.ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose("Link understanding disabled by scope policy.");
    }
    return { outputs: [], urls: [] };
  }

  const message = params.message ?? params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body;
  const links = extractLinksFromMessage(message ?? "", { maxLinks: config?.maxLinks });
  if (links.length === 0) {
    return { outputs: [], urls: [] };
  }

  const entries = config?.models ?? [];
  if (entries.length === 0) {
    return { outputs: [], urls: links };
  }

  const outputs: string[] = [];
  for (const url of links) {
    const output = await runLinkEntries({
      config,
      ctx: params.ctx,
      entries,
      url,
    });
    if (output) {
      outputs.push(output);
    }
  }

  return { outputs, urls: links };
}
