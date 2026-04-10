import { statSync } from "node:fs";
import { EdgeTTS } from "node-edge-tts";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function inferEdgeExtension(outputFormat: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(outputFormat);
  if (normalized.includes("webm")) {
    return ".webm";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("opus")) {
    return ".opus";
  }
  if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) {
    return ".wav";
  }
  return ".mp3";
}

export async function edgeTTS(params: {
  text: string;
  outputPath: string;
  config: {
    voice: string;
    lang: string;
    outputFormat: string;
    saveSubtitles: boolean;
    proxy?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
    timeoutMs?: number;
  };
  timeoutMs: number;
}): Promise<void> {
  const { text, outputPath, config, timeoutMs } = params;
  const tts = new EdgeTTS({
    lang: config.lang,
    outputFormat: config.outputFormat,
    pitch: config.pitch,
    proxy: config.proxy,
    rate: config.rate,
    saveSubtitles: config.saveSubtitles,
    timeout: config.timeoutMs ?? timeoutMs,
    voice: config.voice,
    volume: config.volume,
  });
  await tts.ttsPromise(text, outputPath);

  const { size } = statSync(outputPath);
  if (size === 0) {
    throw new Error("Edge TTS produced empty audio file");
  }
}
