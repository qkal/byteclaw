import { rmSync } from 'node:fs';
import { type TextContent, completeSimple } from '@mariozechner/pi-ai';
import { getApiKeyForModel, requireApiKey } from '../agents/model-auth.js';
import {
  type ModelRef,
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from '../agents/model-selection.js';
import { resolveModelAsync } from '../agents/pi-embedded-runner/model.js';
import { prepareModelForSimpleCompletion } from '../agents/simple-completion-transport.js';
import type { OpenClawConfig } from '../config/config.js';
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from '../shared/string-coerce.js';
import type { ResolvedTtsConfig } from './tts.js';

const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

interface SummarizeTextDeps {
  completeSimple: typeof completeSimple;
  getApiKeyForModel: typeof getApiKeyForModel;
  prepareModelForSimpleCompletion: typeof prepareModelForSimpleCompletion;
  requireApiKey: typeof requireApiKey;
  resolveModelAsync: typeof resolveModelAsync;
}

function resolveDefaultSummarizeTextDeps(): SummarizeTextDeps {
  return {
    completeSimple,
    getApiKeyForModel,
    prepareModelForSimpleCompletion,
    requireApiKey,
    resolveModelAsync,
  };
}

export function requireInRange(
  value: number,
  min: number,
  max: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

export function normalizeLanguageCode(code?: string): string | undefined {
  const normalized = normalizeOptionalLowercaseString(code);
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new Error(
      'languageCode must be a 2-letter ISO 639-1 code (e.g. en, de, fr)',
    );
  }
  return normalized;
}

export function normalizeApplyTextNormalization(
  mode?: string,
): 'auto' | 'on' | 'off' | undefined {
  const normalized = normalizeOptionalLowercaseString(mode);
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'auto' || normalized === 'on' || normalized === 'off') {
    return normalized;
  }
  throw new Error('applyTextNormalization must be one of: auto, on, off');
}

export function normalizeSeed(seed?: number): number | undefined {
  if (seed == null) {
    return undefined;
  }
  const next = Math.floor(seed);
  if (!Number.isFinite(next) || next < 0 || next > 4_294_967_295) {
    throw new Error('seed must be between 0 and 4294967295');
  }
  return next;
}

interface SummarizeResult {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
}

interface SummaryModelSelection {
  ref: ModelRef;
  source: 'summaryModel' | 'default';
}

function resolveSummaryModelRef(
  cfg: OpenClawConfig,
  config: ResolvedTtsConfig,
): SummaryModelSelection {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = normalizeOptionalString(config.summaryModel);
  if (!override) {
    return { ref: defaultRef, source: 'default' };
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: defaultRef.provider,
  });
  const resolved = resolveModelRefFromString({
    aliasIndex,
    defaultProvider: defaultRef.provider,
    raw: override,
  });
  if (!resolved) {
    return { ref: defaultRef, source: 'default' };
  }
  return { ref: resolved.ref, source: 'summaryModel' };
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === 'text';
}

export async function summarizeText(
  params: {
    text: string;
    targetLength: number;
    cfg: OpenClawConfig;
    config: ResolvedTtsConfig;
    timeoutMs: number;
  },
  deps: SummarizeTextDeps = resolveDefaultSummarizeTextDeps(),
): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const { ref } = resolveSummaryModelRef(cfg, config);
  const resolved = await deps.resolveModelAsync(
    ref.provider,
    ref.model,
    undefined,
    cfg,
  );
  if (!resolved.model) {
    throw new Error(
      resolved.error ?? `Unknown summary model: ${ref.provider}/${ref.model}`,
    );
  }
  const completionModel = deps.prepareModelForSimpleCompletion({
    cfg,
    model: resolved.model,
  });
  const apiKey = deps.requireApiKey(
    await deps.getApiKeyForModel({ cfg, model: completionModel }),
    ref.provider,
  );

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await deps.completeSimple(
        completionModel,
        {
          messages: [
            {
              content:
                `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
                `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
                `Reply only with the summary, without additional explanations.\n\n` +
                `<text_to_summarize>\n${text}\n</text_to_summarize>`,
              role: 'user',
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: Math.ceil(targetLength / 2),
          signal: controller.signal,
          temperature: 0.3,
        },
      );
      const summary = res.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(' ')
        .trim();

      if (!summary) {
        throw new Error('No summary returned');
      }

      return {
        inputLength: text.length,
        latencyMs: Date.now() - startTime,
        outputLength: summary.length,
        summary,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const ttsError = error as Error;
    if (ttsError.name === 'AbortError') {
      throw new Error('Summarization timed out', { cause: error });
    }
    throw error;
  }
}

export function scheduleCleanup(
  tempDir: string,
  delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS,
): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { force: true, recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}
