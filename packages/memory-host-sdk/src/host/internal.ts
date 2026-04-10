import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime } from "../../../../src/media/mime.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../../src/utils/cjk-chars.js";
import { runTasksWithConcurrency } from "../../../../src/utils/run-with-concurrency.js";
import { estimateStructuredEmbeddingInputBytes } from "./embedding-input-limits.js";
import { type EmbeddingInput, buildTextEmbeddingInput } from "./embedding-inputs.js";
import { isFileMissingError } from "./fs-utils.js";
import {
  type MemoryMultimodalModality,
  type MemoryMultimodalSettings,
  buildMemoryMultimodalLabel,
  classifyMemoryMultimodalPath,
} from "./multimodal.js";

export interface MemoryFileEntry {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  dataHash?: string;
  kind?: "markdown" | "multimodal";
  contentText?: string;
  modality?: MemoryMultimodalModality;
  mimeType?: string;
}

export interface MemoryChunk {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
}

export interface MultimodalMemoryChunk {
  chunk: MemoryChunk;
  structuredInputBytes: number;
}

const DISABLED_MULTIMODAL_SETTINGS: MemoryMultimodalSettings = {
  enabled: false,
  maxFileBytes: 0,
  modalities: [],
};

export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

export function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[] {
  if (!extraPaths?.length) {
    return [];
  }
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value),
    );
  return [...new Set(resolved)];
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md" || normalized === "dreams.md") {
    return true;
  }
  return normalized.startsWith("memory/");
}

function isAllowedMemoryFilePath(filePath: string, multimodal?: MemoryMultimodalSettings): boolean {
  if (filePath.endsWith(".md")) {
    return true;
  }
  return (
    classifyMemoryMultimodalPath(filePath, multimodal ?? DISABLED_MULTIMODAL_SETTINGS) !== null
  );
}

async function walkDir(dir: string, files: string[], multimodal?: MemoryMultimodalSettings) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(full, files, multimodal);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!isAllowedMemoryFilePath(full, multimodal)) {
      continue;
    }
    files.push(full);
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[],
  multimodal?: MemoryMultimodalSettings,
): Promise<string[]> {
  const result: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const addMarkdownFile = async (absPath: string) => {
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return;
      }
      if (!absPath.endsWith(".md")) {
        return;
      }
      result.push(absPath);
    } catch {}
  };

  await addMarkdownFile(memoryFile);
  await addMarkdownFile(altMemoryFile);
  try {
    const dirStat = await fs.lstat(memoryDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      await walkDir(memoryDir, result);
    }
  } catch {}

  const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const inputPath of normalizedExtraPaths) {
      try {
        const stat = await fs.lstat(inputPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await walkDir(inputPath, result, multimodal);
          continue;
        }
        if (stat.isFile() && isAllowedMemoryFilePath(inputPath, multimodal)) {
          result.push(inputPath);
        }
      } catch {}
    }
  }
  if (result.length <= 1) {
    return result;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
  multimodal?: MemoryMultimodalSettings,
): Promise<MemoryFileEntry | null> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
  const normalizedPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
  const multimodalSettings = multimodal ?? DISABLED_MULTIMODAL_SETTINGS;
  const modality = classifyMemoryMultimodalPath(absPath, multimodalSettings);
  if (modality) {
    if (stat.size > multimodalSettings.maxFileBytes) {
      return null;
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absPath);
    } catch (error) {
      if (isFileMissingError(error)) {
        return null;
      }
      throw error;
    }
    const mimeType = await detectMime({ buffer: buffer.subarray(0, 512), filePath: absPath });
    if (!mimeType || !mimeType.startsWith(`${modality}/`)) {
      return null;
    }
    const contentText = buildMemoryMultimodalLabel(modality, normalizedPath);
    const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const chunkHash = hashText(
      JSON.stringify({
        contentText,
        dataHash,
        mimeType,
        path: normalizedPath,
      }),
    );
    return {
      absPath,
      contentText,
      dataHash,
      hash: chunkHash,
      kind: "multimodal",
      mimeType,
      modality,
      mtimeMs: stat.mtimeMs,
      path: normalizedPath,
      size: stat.size,
    };
  }
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
  const hash = hashText(content);
  return {
    absPath,
    hash,
    kind: "markdown",
    mtimeMs: stat.mtimeMs,
    path: normalizedPath,
    size: stat.size,
  };
}

async function loadMultimodalEmbeddingInput(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "size" | "dataHash"
  >,
): Promise<EmbeddingInput | null> {
  if (entry.kind !== "multimodal" || !entry.contentText || !entry.mimeType) {
    return null;
  }
  let stat;
  try {
    stat = await fs.stat(entry.absPath);
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
  if (stat.size !== entry.size) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(entry.absPath);
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
  const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (entry.dataHash && entry.dataHash !== dataHash) {
    return null;
  }
  return {
    parts: [
      { text: entry.contentText, type: "text" },
      {
        data: buffer.toString("base64"),
        mimeType: entry.mimeType,
        type: "inline-data",
      },
    ],
    text: entry.contentText,
  };
}

export async function buildMultimodalChunkForIndexing(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "hash" | "size" | "dataHash"
  >,
): Promise<MultimodalMemoryChunk | null> {
  const embeddingInput = await loadMultimodalEmbeddingInput(entry);
  if (!embeddingInput) {
    return null;
  }
  return {
    chunk: {
      embeddingInput,
      endLine: 1,
      hash: entry.hash,
      startLine: 1,
      text: entry.contentText ?? embeddingInput.text,
    },
    structuredInputBytes: estimateStructuredEmbeddingInputBytes(embeddingInput),
  };
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const maxChars = Math.max(32, chunking.tokens * CHARS_PER_TOKEN_ESTIMATE);
  const overlapChars = Math.max(0, chunking.overlap * CHARS_PER_TOKEN_ESTIMATE);
  const chunks: MemoryChunk[] = [];

  let current: { line: string; lineNo: number }[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) {
      return;
    }
    const text = current.map((entry) => entry.line).join("\n");
    const startLine = firstEntry.lineNo;
    const endLine = lastEntry.lineNo;
    chunks.push({
      embeddingInput: buildTextEmbeddingInput(text),
      endLine,
      hash: hashText(text),
      startLine,
      text,
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: { line: string; lineNo: number }[] = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) {
        continue;
      }
      acc += estimateStringChars(entry.line) + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) {
        break;
      }
    }
    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + estimateStringChars(entry.line) + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      // First pass: slice at maxChars (preserves original behaviour for Latin).
      // Second pass: if a segment's *weighted* size still exceeds the budget
      // (happens for CJK-heavy text where 1 char ≈ 1 token), re-split it at
      // Chunking.tokens so the chunk stays within the token budget.
      for (let start = 0; start < line.length; start += maxChars) {
        const coarse = line.slice(start, start + maxChars);
        if (estimateStringChars(coarse) > maxChars) {
          const fineStep = Math.max(1, chunking.tokens);
          for (let j = 0; j < coarse.length; ) {
            let end = Math.min(j + fineStep, coarse.length);
            // Avoid splitting inside a UTF-16 surrogate pair (CJK Extension B+).
            if (end < coarse.length) {
              const code = coarse.charCodeAt(end - 1);
              if (code >= 0xD8_00 && code <= 0xDB_FF) {
                end += 1; // Include the low surrogate
              }
            }
            segments.push(coarse.slice(j, end));
            j = end; // Advance cursor to the adjusted boundary
          }
        } else {
          segments.push(coarse);
        }
      }
    }
    for (const segment of segments) {
      const lineSize = estimateStringChars(segment) + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

/**
 * Remap chunk startLine/endLine from content-relative positions to original
 * source file positions using a lineMap.  Each entry in lineMap gives the
 * 1-indexed source line for the corresponding 0-indexed content line.
 *
 * This is used for session JSONL files where buildSessionEntry() flattens
 * messages into a plain-text string before chunking.  Without remapping the
 * stored line numbers would reference positions in the flattened text rather
 * than the original JSONL file.
 */
export function remapChunkLines(chunks: MemoryChunk[], lineMap: number[] | undefined): void {
  if (!lineMap || lineMap.length === 0) {
    return;
  }
  for (const chunk of chunks) {
    // StartLine/endLine are 1-indexed; lineMap is 0-indexed by content line
    chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
    chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
  }
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const { results, firstError, hasError } = await runTasksWithConcurrency({
    errorMode: "stop",
    limit,
    tasks,
  });
  if (hasError) {
    throw firstError;
  }
  return results;
}
