import {
  type Api,
  type AssistantMessageEvent,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  streamSimple,
} from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  type SessionEntry,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../config/sessions.js";
import { diagnosticLogger as diag } from "../logging/diagnostic.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { resolveSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import {
  type ImageSanitizationLimits,
  resolveImageSanitizationLimits,
} from "./image-sanitization.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { type BlockReplyChunking, EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import { resolveModelWithRegistry } from "./pi-embedded-runner/model.js";
import { getActiveEmbeddedRunSnapshot } from "./pi-embedded-runner/runs.js";
import { streamWithPayloadPatch } from "./pi-embedded-runner/stream-payload-utils.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";
import { sanitizeImageBlocks } from "./tool-images.js";

interface SessionManagerLike {
  getLeafEntry?: () => {
    id?: string;
    type?: string;
    parentId?: string | null;
    message?: { role?: string };
  } | null;
  branch?: (parentId: string) => void;
  resetLeaf?: () => void;
  buildSessionContext: () => { messages?: unknown[] };
}

function collectTextContent(content: { type?: string; text?: string }[]): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function collectThinkingContent(content: { type?: string; thinking?: string }[]): string {
  return content
    .filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

function buildBtwSystemPrompt(): string {
  return [
    "You are answering an ephemeral /btw side question about the current conversation.",
    "Use the conversation only as background context.",
    "Answer only the side question in the last user message.",
    "Do not continue, resume, or complete any unfinished task from the conversation.",
    "Do not emit tool calls, pseudo-tool calls, shell commands, file writes, patches, or code unless the side question explicitly asks for them.",
    "Do not say you will continue the main task after answering.",
    "If the question can be answered briefly, answer briefly.",
  ].join("\n");
}

function buildBtwQuestionPrompt(question: string, inFlightPrompt?: string): string {
  const lines = [
    "Answer this side question only.",
    "Ignore any unfinished task in the conversation while answering it.",
  ];
  const trimmedPrompt = inFlightPrompt?.trim();
  if (trimmedPrompt) {
    lines.push(
      "",
      "Current in-flight main task request for background context only:",
      "<in_flight_main_task>",
      trimmedPrompt,
      "</in_flight_main_task>",
      "Do not continue or complete that task while answering the side question.",
    );
  }
  lines.push("", "<btw_side_question>", question.trim(), "</btw_side_question>");
  return lines.join("\n");
}

function normalizeBtwContentBlocks(content: unknown): unknown[] | undefined {
  if (Array.isArray(content)) {
    return content;
  }
  if (content && typeof content === "object") {
    return [content];
  }
  return undefined;
}

function isBtwTextBlock(block: unknown): block is TextContent {
  if (!block || typeof block !== "object") {
    return false;
  }
  const record = block as { type?: unknown; text?: unknown };
  return normalizeLowercaseStringOrEmpty(record.type) === "text" && typeof record.text === "string";
}

function isBtwImageBlock(block: unknown): block is ImageContent {
  if (!block || typeof block !== "object") {
    return false;
  }
  const record = block as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    normalizeLowercaseStringOrEmpty(record.type) === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

async function sanitizeBtwUserMessage(params: {
  message: Extract<Message, { role: "user" }>;
  imageLimits: ImageSanitizationLimits;
}): Promise<Extract<Message, { role: "user" }> | undefined> {
  if (typeof params.message.content === "string") {
    return params.message;
  }
  const blocks = normalizeBtwContentBlocks(params.message.content);
  if (!blocks) {
    return undefined;
  }

  const content: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (isBtwTextBlock(block)) {
      content.push({ text: block.text, type: "text" });
      continue;
    }
    if (!isBtwImageBlock(block)) {
      continue;
    }
    const { images } = await sanitizeImageBlocks([block], "btw:context", params.imageLimits);
    const image = images[0];
    if (image) {
      content.push(image);
    }
  }

  if (content.length === 0) {
    return undefined;
  }
  return {
    ...params.message,
    content,
  };
}

function sanitizeBtwAssistantMessage(
  message: Extract<Message, { role: "assistant" }>,
): Extract<Message, { role: "assistant" }> | undefined {
  const rawContent = (message as { content?: unknown }).content;
  if (typeof rawContent === "string") {
    const trimmed = rawContent.trim();
    return trimmed.length > 0
      ? {
          ...message,
          content: [{ text: trimmed, type: "text" }],
        }
      : undefined;
  }
  const blocks = normalizeBtwContentBlocks(rawContent);
  if (!blocks) {
    return undefined;
  }
  const content = blocks.flatMap((block): TextContent[] =>
    isBtwTextBlock(block) ? [{ text: block.text, type: "text" }] : [],
  );
  if (content.length === 0) {
    return undefined;
  }
  return {
    ...message,
    content,
  };
}

async function toSimpleContextMessages(params: {
  messages: unknown[];
  imageLimits: ImageSanitizationLimits;
}): Promise<Message[]> {
  const contextMessages: Message[] = [];
  for (const message of params.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const {role} = (message as { role?: unknown });
    if (role === "user") {
      const sanitizedMessage = await sanitizeBtwUserMessage({
        imageLimits: params.imageLimits,
        message: message as Extract<Message, { role: "user" }>,
      });
      if (sanitizedMessage) {
        contextMessages.push(sanitizedMessage);
      }
      continue;
    }
    if (role !== "assistant") {
      continue;
    }
    // BTW is a no-tools path, so keep only user-visible blocks from prior
    // Messages and strip hidden reasoning/tool replay data.
    const sanitizedMessage = sanitizeBtwAssistantMessage(
      message as Extract<Message, { role: "assistant" }>,
    );
    if (sanitizedMessage) {
      contextMessages.push(sanitizedMessage);
    }
  }
  return stripToolResultDetails(
    contextMessages as Parameters<typeof stripToolResultDetails>[0],
  ) as Message[];
}

function resolveSessionTranscriptPath(params: {
  sessionId: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): string | undefined {
  try {
    const agentId = params.sessionKey?.split(":")[1];
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: params.storePath,
    });
    return resolveSessionFilePath(params.sessionId, params.sessionEntry, pathOpts);
  } catch (error) {
    diag.debug(
      `resolveSessionTranscriptPath failed: sessionId=${params.sessionId} err=${String(error)}`,
    );
    return undefined;
  }
}

async function resolveRuntimeModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
}): Promise<{
  model: Model<Api>;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const model = resolveModelWithRegistry({
    cfg: params.cfg,
    modelId: params.model,
    modelRegistry,
    provider: params.provider,
  });
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.model}`);
  }

  const authProfileId = await resolveSessionAuthProfileOverride({
    agentDir: params.agentDir,
    cfg: params.cfg,
    isNewSession: params.isNewSession,
    provider: params.provider,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
  });
  return {
    authProfileId,
    authProfileIdSource: params.sessionEntry?.authProfileOverrideSource,
    model,
  };
}

interface RunBtwSideQuestionParams {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
  question: string;
  sessionEntry: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  resolvedThinkLevel?: ThinkLevel;
  resolvedReasoningLevel: ReasoningLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  opts?: GetReplyOptions;
  isNewSession: boolean;
}

export async function runBtwSideQuestion(
  params: RunBtwSideQuestionParams,
): Promise<ReplyPayload | undefined> {
  const sessionId = params.sessionEntry.sessionId?.trim();
  if (!sessionId) {
    throw new Error("No active session context.");
  }

  const sessionFile = resolveSessionTranscriptPath({
    sessionEntry: params.sessionEntry,
    sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!sessionFile) {
    throw new Error("No active session transcript.");
  }

  const sessionManager = SessionManager.open(sessionFile) as SessionManagerLike;
  const activeRunSnapshot = getActiveEmbeddedRunSnapshot(sessionId);
  const imageLimits = resolveImageSanitizationLimits(params.cfg);
  let messages: Message[] = [];
  let inFlightPrompt: string | undefined;
  if (Array.isArray(activeRunSnapshot?.messages) && activeRunSnapshot.messages.length > 0) {
    messages = await toSimpleContextMessages({
      imageLimits,
      messages: activeRunSnapshot.messages,
    });
    ({ inFlightPrompt } = activeRunSnapshot);
  } else if (activeRunSnapshot) {
    ({ inFlightPrompt } = activeRunSnapshot);
    if (activeRunSnapshot.transcriptLeafId && sessionManager.branch) {
      try {
        sessionManager.branch(activeRunSnapshot.transcriptLeafId);
      } catch (error) {
        diag.debug(
          `btw snapshot leaf unavailable: sessionId=${sessionId} leaf=${activeRunSnapshot.transcriptLeafId} err=${String(error)}`,
        );
        sessionManager.resetLeaf?.();
      }
    } else {
      sessionManager.resetLeaf?.();
    }
  } else {
    const leafEntry = sessionManager.getLeafEntry?.();
    if (leafEntry?.type === "message" && leafEntry.message?.role === "user") {
      if (leafEntry.parentId && sessionManager.branch) {
        sessionManager.branch(leafEntry.parentId);
      } else {
        sessionManager.resetLeaf?.();
      }
    }
  }
  if (messages.length === 0) {
    const sessionContext = sessionManager.buildSessionContext();
    messages = await toSimpleContextMessages({
      imageLimits,
      messages: Array.isArray(sessionContext.messages) ? sessionContext.messages : [],
    });
  }
  if (messages.length === 0 && !inFlightPrompt?.trim()) {
    throw new Error("No active session context.");
  }

  const { model, authProfileId } = await resolveRuntimeModel({
    agentDir: params.agentDir,
    cfg: params.cfg,
    isNewSession: params.isNewSession,
    model: params.model,
    provider: params.provider,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
  });
  const apiKeyInfo = await getApiKeyForModel({
    agentDir: params.agentDir,
    cfg: params.cfg,
    model,
    profileId: authProfileId,
  });
  let runtimeModel = model;
  let apiKey =
    apiKeyInfo.mode === "aws-sdk" && !apiKeyInfo.apiKey
      ? undefined
      : requireApiKey(apiKeyInfo, model.provider);
  if (apiKey) {
    const sessionAgentId = resolveSessionAgentId({
      config: params.cfg,
      sessionKey: params.sessionKey,
    });
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, sessionAgentId);
    const preparedAuth = await prepareProviderRuntimeAuth({
      config: params.cfg,
      context: {
        agentDir: params.agentDir,
        apiKey,
        authMode: apiKeyInfo.mode,
        config: params.cfg,
        env: process.env,
        model,
        modelId: model.id,
        profileId: authProfileId,
        provider: model.provider,
        workspaceDir,
      },
      env: process.env,
      provider: model.provider,
      workspaceDir,
    });
    if (preparedAuth?.baseUrl) {
      runtimeModel = {
        ...runtimeModel,
        baseUrl: preparedAuth.baseUrl,
      };
    }
    if (preparedAuth?.apiKey) {
      ({ apiKey } = preparedAuth);
    }
  }

  const chunker =
    params.opts?.onBlockReply && params.blockReplyChunking
      ? new EmbeddedBlockChunker(params.blockReplyChunking)
      : undefined;
  let emittedBlocks = 0;
  let blockEmitChain: Promise<void> = Promise.resolve();
  let answerText = "";
  let reasoningText = "";
  let assistantStarted = false;
  let sawTextEvent = false;

  const emitBlockChunk = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !params.opts?.onBlockReply) {
      return;
    }
    emittedBlocks += 1;
    blockEmitChain = blockEmitChain.then(async () => {
      await params.opts?.onBlockReply?.({
        btw: { question: params.question },
        text,
      });
    });
    await blockEmitChain;
  };

  const stream = await streamWithPayloadPatch(
    streamSimple,
    runtimeModel,
    {
      messages: [
        ...messages,
        {
          content: [
            {
              type: "text",
              text: buildBtwQuestionPrompt(params.question, inFlightPrompt),
            },
          ],
          role: "user",
          timestamp: Date.now(),
        },
      ],
      systemPrompt: buildBtwSystemPrompt(),
    },
    {
      apiKey,
      // BTW is intentionally a lightweight side question path. Keep provider
      // Reasoning off so we reliably receive answer text instead of thinking-only output.
      reasoning: undefined,
      signal: params.opts?.abortSignal,
    },
    (payloadObj) => {
      // BTW is intentionally tool-less. Some OpenAI-compatible providers reject
      // The empty tools arrays injected for generic tool-history replay.
      if (Array.isArray(payloadObj.tools) && payloadObj.tools.length === 0) {
        delete payloadObj.tools;
      }
    },
  );

  let finalEvent:
    | Extract<AssistantMessageEvent, { type: "done" }>
    | Extract<AssistantMessageEvent, { type: "error" }>
    | undefined;

  for await (const event of stream) {
    finalEvent = event.type === "done" || event.type === "error" ? event : finalEvent;

    if (!assistantStarted && (event.type === "text_start" || event.type === "start")) {
      assistantStarted = true;
      await params.opts?.onAssistantMessageStart?.();
    }

    if (event.type === "text_delta") {
      sawTextEvent = true;
      answerText += event.delta;
      chunker?.append(event.delta);
      if (chunker && params.resolvedBlockStreamingBreak === "text_end") {
        chunker.drain({ emit: (chunk) => void emitBlockChunk(chunk), force: false });
      }
      continue;
    }

    if (event.type === "text_end" && chunker && params.resolvedBlockStreamingBreak === "text_end") {
      chunker.drain({ emit: (chunk) => void emitBlockChunk(chunk), force: true });
      continue;
    }

    if (event.type === "thinking_delta") {
      reasoningText += event.delta;
      if (params.resolvedReasoningLevel !== "off") {
        await params.opts?.onReasoningStream?.({ isReasoning: true, text: reasoningText });
      }
      continue;
    }

    if (event.type === "thinking_end" && params.resolvedReasoningLevel !== "off") {
      await params.opts?.onReasoningEnd?.();
    }
  }

  if (chunker && params.resolvedBlockStreamingBreak !== "text_end" && chunker.hasBuffered()) {
    chunker.drain({ emit: (chunk) => void emitBlockChunk(chunk), force: true });
  }
  await blockEmitChain;

  if (finalEvent?.type === "error") {
    const message = collectTextContent(finalEvent.error.content);
    throw new Error(message || finalEvent.error.errorMessage || "BTW failed.");
  }

  const finalMessage = finalEvent?.type === "done" ? finalEvent.message : undefined;
  if (finalMessage) {
    if (!sawTextEvent) {
      answerText = collectTextContent(finalMessage.content);
    }
    if (!reasoningText) {
      reasoningText = collectThinkingContent(finalMessage.content);
    }
  }

  const answer = answerText.trim();
  if (!answer) {
    throw new Error("No BTW response generated.");
  }

  if (emittedBlocks > 0) {
    return undefined;
  }

  return { text: answer };
}
