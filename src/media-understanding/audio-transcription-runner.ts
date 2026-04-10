import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  type ActiveMediaModel,
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";
import type { MediaAttachment, MediaUnderstandingProvider } from "./types.js";

export async function runAudioTranscription(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  attachments?: MediaAttachment[];
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  localPathRoots?: readonly string[];
}): Promise<{ transcript: string | undefined; attachments: MediaAttachment[] }> {
  const attachments = params.attachments ?? normalizeMediaAttachments(params.ctx);
  if (attachments.length === 0) {
    return { attachments, transcript: undefined };
  }

  const providerRegistry = buildProviderRegistry(params.providers, params.cfg);
  const cache = createMediaAttachmentCache(
    attachments,
    params.localPathRoots ? { localPathRoots: params.localPathRoots } : undefined,
  );

  try {
    const result = await runCapability({
      activeModel: params.activeModel,
      agentDir: params.agentDir,
      attachments: cache,
      capability: "audio",
      cfg: params.cfg,
      config: params.cfg.tools?.media?.audio,
      ctx: params.ctx,
      media: attachments,
      providerRegistry,
    });
    const output = result.outputs.find((entry) => entry.kind === "audio.transcription");
    const transcript = output?.text?.trim();
    return { attachments, transcript: transcript || undefined };
  } finally {
    await cache.cleanup();
  }
}
