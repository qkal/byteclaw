import { type OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { type SignalTextStyleRange, markdownToSignalText } from "./format.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export interface SignalSendOpts {
  cfg?: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
}

export interface SignalSendResult {
  messageId: string;
  timestamp?: number;
}

export type SignalRpcOpts = Pick<SignalSendOpts, "baseUrl" | "account" | "accountId" | "timeoutMs">;

export type SignalReceiptType = "read" | "viewed";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

let signalConfigRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/config-runtime")>
  | undefined;

async function loadSignalConfigRuntime() {
  signalConfigRuntimePromise ??= import("openclaw/plugin-sdk/config-runtime");
  return await signalConfigRuntimePromise;
}

async function resolveSignalRpcAccountInfo(
  opts: Pick<SignalSendOpts, "cfg" | "baseUrl" | "account" | "accountId">,
) {
  if (opts.baseUrl?.trim() && opts.account?.trim()) {
    return undefined;
  }
  const cfg = opts.cfg ?? (await loadSignalConfigRuntime()).loadConfig();
  return resolveSignalAccount({
    accountId: opts.accountId,
    cfg,
  });
}

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  const lower = normalizeLowercaseStringOrEmpty(value);
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (normalized.startsWith("group:")) {
    return { groupId: value.slice("group:".length).trim(), type: "group" };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  if (normalized.startsWith("u:")) {
    return { type: "username", username: value.trim() };
  }
  return { recipient: value, type: "recipient" };
}

interface SignalTargetParams {
  recipient?: string[];
  groupId?: string;
  username?: string[];
}

interface SignalTargetAllowlist {
  recipient?: boolean;
  group?: boolean;
  username?: boolean;
}

function buildTargetParams(
  target: SignalTarget,
  allow: SignalTargetAllowlist,
): SignalTargetParams | null {
  if (target.type === "recipient") {
    if (!allow.recipient) {
      return null;
    }
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) {
      return null;
    }
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) {
      return null;
    }
    return { username: [target.username] };
  }
  return null;
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  const cfg = opts.cfg ?? loadConfig();
  const accountInfo = resolveSignalAccount({
    accountId: opts.accountId,
    cfg,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  let message = text ?? "";
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = opts.textMode ?? "markdown";
  const maxBytes = (() => {
    if (typeof opts.maxBytes === "number") {
      return opts.maxBytes;
    }
    if (typeof accountInfo.config.mediaMaxMb === "number") {
      return accountInfo.config.mediaMaxMb * 1024 * 1024;
    }
    if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
      return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
    }
    return 8 * 1024 * 1024;
  })();

  let attachments: string[] | undefined;
  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
      localRoots: opts.mediaLocalRoots,
      mediaAccess: opts.mediaAccess,
      readFile: opts.mediaReadFile,
    });
    attachments = [resolved.path];
    const kind = kindFromMime(resolved.contentType ?? undefined);
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      messageFromPlaceholder = true;
    }
  }

  if (message.trim() && !messageFromPlaceholder) {
    if (textMode === "plain") {
      textStyles = opts.textStyles ?? [];
    } else {
      const tableMode = resolveMarkdownTableMode({
        accountId: accountInfo.accountId,
        cfg,
        channel: "signal",
      });
      const formatted = markdownToSignalText(message, { tableMode });
      message = formatted.text;
      textStyles = formatted.styles;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  const params: Record<string, unknown> = { message };
  if (textStyles.length > 0) {
    params["text-style"] = textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }
  if (account) {
    params.account = account;
  }
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }

  const targetParams = buildTargetParams(target, {
    group: true,
    recipient: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  Object.assign(params, targetParams);

  const result = await signalRpcRequest<{ timestamp?: number }>("send", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean } = {},
): Promise<boolean> {
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    group: true,
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = { ...targetParams };
  if (account) {
    params.account = account;
  }
  if (opts.stop) {
    params.stop = true;
  }
  await signalRpcRequest("sendTyping", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType } = {},
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("sendReceipt", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}
